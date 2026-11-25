"""GitHub REST enrichment queue, response cache, and bounded retries.

The worker calls ``GET /repositories/{id}`` so a later rename does not miss
the cache. Successful bodies are stored unchanged under the API bronze root.
A later refresh sends ``If-None-Match`` and, on 304, only moves the cache
timestamp forward.

Rate limits are not retries. A 429, or a 403 that GitHub marks as a rate
limit, defers the repository until the reset time and stops the run. Other
403 responses are permanent. Transient HTTP and network failures use
exponential backoff and stop after ``max_attempts``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sqlite3
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Mapping

from fetch_gh_archive import USER_AGENT, TransientError, _normalize_headers, ssl_context
import schemas


_LOG = logging.getLogger("github_api")
API_ACCEPT = "application/vnd.github+json"
API_VERSION = "2022-11-28"
MAX_BACKOFF_SECONDS = 30
_TRANSIENT_STATUS = {408, 409, 500, 502, 503, 504}
_SCHEMA = """
CREATE TABLE IF NOT EXISTS enrichment_queue (
    repo_id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    api_url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'deferred', 'succeeded', 'failed')),
    reason TEXT NOT NULL CHECK (reason IN ('missing', 'refresh')),
    attempts INTEGER NOT NULL,
    permanent INTEGER NOT NULL,
    enqueued_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    next_attempt_at TEXT,
    last_error TEXT,
    last_status_code INTEGER
);

CREATE TABLE IF NOT EXISTS metadata_cache (
    repo_id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    etag TEXT,
    fetched_at TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    incomplete INTEGER NOT NULL,
    snapshot_path TEXT,
    description TEXT,
    topics_json TEXT NOT NULL,
    language TEXT,
    html_url TEXT,
    created_at TEXT,
    updated_at TEXT,
    visibility TEXT,
    archived INTEGER,
    stargazers_count INTEGER,
    forks_count INTEGER
);

CREATE TABLE IF NOT EXISTS api_budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    remaining INTEGER,
    reset_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_due
ON enrichment_queue (status, next_attempt_at, enqueued_at, repo_id);
"""

Opener = Callable[[str, str, Mapping[str, str]], "ApiResponse"]
Sleeper = Callable[[float], None]


class ApiResponse:
    """HTTP response. Header names are stored in lower case."""

    def __init__(self, status: int, headers: Mapping[str, str] | None = None, body: bytes = b""):
        self.status = int(status)
        self.headers = {str(key).lower(): str(value) for key, value in (headers or {}).items()}
        self.body = body if isinstance(body, bytes) else str(body).encode("utf-8")


@dataclass(frozen=True)
class EnqueueResult:
    enqueued: int = 0
    already_queued: int = 0
    fresh: int = 0
    skipped_permanent: int = 0
    waiting_retry: int = 0

    def add(self, other: "EnqueueResult") -> "EnqueueResult":
        return EnqueueResult(
            self.enqueued + other.enqueued,
            self.already_queued + other.already_queued,
            self.fresh + other.fresh,
            self.skipped_permanent + other.skipped_permanent,
            self.waiting_retry + other.waiting_retry,
        )


@dataclass(frozen=True)
class QueueItem:
    repo_id: int
    full_name: str
    api_url: str
    status: str
    reason: str
    attempts: int
    permanent: bool
    enqueued_at: str
    updated_at: str
    next_attempt_at: str | None
    last_error: str | None
    last_status_code: int | None


@dataclass(frozen=True)
class CacheEntry:
    repo_id: int
    full_name: str
    etag: str | None
    fetched_at: str
    http_status: int
    incomplete: bool
    snapshot_path: str | None
    description: str | None
    topics: tuple[str, ...]
    language: str | None
    html_url: str | None
    created_at: str | None
    updated_at: str | None
    visibility: str | None
    archived: bool | None
    stargazers_count: int | None
    forks_count: int | None


@dataclass(frozen=True)
class ApiBudget:
    remaining: int | None
    reset_at: str | None
    updated_at: str


@dataclass
class DrainSummary:
    succeeded: int = 0
    not_modified: int = 0
    failed: int = 0
    deferred: int = 0
    requests: int = 0
    stopped_reason: str = ""


class EnrichmentStore:
    """SQLite queue and metadata cache. One connection, used from one thread."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "EnrichmentStore":
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()

    def enqueue(
        self,
        repos,
        *,
        now: datetime,
        refresh_after: timedelta,
        retry_after: timedelta,
    ) -> EnqueueResult:
        """Queue repositories that are missing, stale, or ready for another try.

        Pending rows are left untouched. Permanent failures stay failed.
        A non-permanent failure is queued again only after ``retry_after``.
        A successful cache newer than ``refresh_after`` is left alone.
        """
        totals = EnqueueResult()
        now_text = schemas.format_utc(now)
        with self._conn:
            for observed in repos:
                kind = self._enqueue_one(observed, now, now_text, refresh_after, retry_after)
                totals = totals.add(EnqueueResult(**{kind: 1}))
        return totals

    def queue_item(self, repo_id: int) -> QueueItem | None:
        row = self._conn.execute(
            "SELECT * FROM enrichment_queue WHERE repo_id = ?",
            (repo_id,),
        ).fetchone()
        return None if row is None else _queue_item(row)

    def cache_entry(self, repo_id: int) -> CacheEntry | None:
        row = self._conn.execute(
            "SELECT * FROM metadata_cache WHERE repo_id = ?",
            (repo_id,),
        ).fetchone()
        return None if row is None else _cache_entry(row)

    def due_items(self, now: datetime, limit: int) -> list[QueueItem]:
        if limit < 1:
            return []
        rows = self._conn.execute(
            """
            SELECT * FROM enrichment_queue
            WHERE permanent = 0
              AND status IN ('pending', 'deferred')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY enqueued_at, repo_id
            LIMIT ?
            """,
            (schemas.format_utc(now), limit),
        ).fetchall()
        return [_queue_item(row) for row in rows]

    def list_failures(self) -> list[QueueItem]:
        rows = self._conn.execute(
            "SELECT * FROM enrichment_queue WHERE status = 'failed' ORDER BY repo_id"
        ).fetchall()
        return [_queue_item(row) for row in rows]

    def queue_counts(self) -> dict[str, int]:
        rows = self._conn.execute(
            "SELECT status, COUNT(*) AS c FROM enrichment_queue GROUP BY status"
        ).fetchall()
        return {str(row["status"]): int(row["c"]) for row in rows}

    def budget(self) -> ApiBudget | None:
        row = self._conn.execute("SELECT * FROM api_budget WHERE id = 1").fetchone()
        if row is None:
            return None
        remaining = None if row["remaining"] is None else int(row["remaining"])
        return ApiBudget(remaining, row["reset_at"], str(row["updated_at"]))

    def observe_budget(self, headers: Mapping[str, str], now: datetime) -> None:
        remaining = _header_int(headers, "x-ratelimit-remaining")
        reset_epoch = _header_int(headers, "x-ratelimit-reset")
        if remaining is None and reset_epoch is None:
            return
        current = self.budget()
        reset_at = None if current is None else current.reset_at
        if reset_epoch is not None:
            reset_at = schemas.format_utc(datetime.fromtimestamp(reset_epoch, tz=timezone.utc))
        if remaining is None and current is not None:
            remaining = current.remaining
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO api_budget (id, remaining, reset_at, updated_at)
                VALUES (1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    remaining = excluded.remaining,
                    reset_at = excluded.reset_at,
                    updated_at = excluded.updated_at
                """,
                (remaining, reset_at, schemas.format_utc(now)),
            )

    def record_success(
        self,
        item: QueueItem,
        *,
        attempts: int,
        now: datetime,
        snapshot_path: Path,
        etag: str | None,
        metadata: Mapping[str, object],
    ) -> None:
        fetched_at = schemas.format_utc(now)
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO metadata_cache (
                    repo_id, full_name, etag, fetched_at, http_status, incomplete,
                    snapshot_path, description, topics_json, language, html_url,
                    created_at, updated_at, visibility, archived, stargazers_count,
                    forks_count
                ) VALUES (?, ?, ?, ?, 200, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo_id) DO UPDATE SET
                    full_name = excluded.full_name,
                    etag = excluded.etag,
                    fetched_at = excluded.fetched_at,
                    http_status = 200,
                    incomplete = 0,
                    snapshot_path = excluded.snapshot_path,
                    description = excluded.description,
                    topics_json = excluded.topics_json,
                    language = excluded.language,
                    html_url = excluded.html_url,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    visibility = excluded.visibility,
                    archived = excluded.archived,
                    stargazers_count = excluded.stargazers_count,
                    forks_count = excluded.forks_count
                """,
                (
                    item.repo_id,
                    metadata["full_name"],
                    etag,
                    fetched_at,
                    str(snapshot_path),
                    metadata["description"],
                    json.dumps(list(metadata["topics"]), ensure_ascii=False),
                    metadata["language"],
                    metadata["html_url"],
                    metadata["created_at"],
                    metadata["updated_at"],
                    metadata["visibility"],
                    _bit(metadata["archived"]),
                    metadata["stargazers_count"],
                    metadata["forks_count"],
                ),
            )
            self._finish_queue(
                item.repo_id,
                status="succeeded",
                attempts=attempts,
                permanent=0,
                now_text=fetched_at,
                next_attempt_at=None,
                last_error=None,
                last_status_code=200,
            )

    def record_not_modified(
        self,
        repo_id: int,
        *,
        attempts: int,
        now: datetime,
        etag: str | None,
    ) -> None:
        fetched_at = schemas.format_utc(now)
        with self._conn:
            self._conn.execute(
                """
                UPDATE metadata_cache
                SET fetched_at = ?, http_status = 304, etag = COALESCE(?, etag)
                WHERE repo_id = ?
                """,
                (fetched_at, etag, repo_id),
            )
            self._finish_queue(
                repo_id,
                status="succeeded",
                attempts=attempts,
                permanent=0,
                now_text=fetched_at,
                next_attempt_at=None,
                last_error=None,
                last_status_code=304,
            )

    def record_failure(
        self,
        item: QueueItem,
        *,
        attempts: int,
        permanent: bool,
        now: datetime,
        status_code: int | None,
        error: str,
        snapshot_path: Path | None = None,
        etag: str | None = None,
    ) -> None:
        now_text = schemas.format_utc(now)
        with self._conn:
            if permanent:
                self._conn.execute(
                    """
                    INSERT INTO metadata_cache (
                        repo_id, full_name, etag, fetched_at, http_status, incomplete,
                        snapshot_path, description, topics_json, language, html_url,
                        created_at, updated_at, visibility, archived, stargazers_count,
                        forks_count
                    ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
                    ON CONFLICT(repo_id) DO UPDATE SET
                        full_name = excluded.full_name,
                        etag = excluded.etag,
                        fetched_at = excluded.fetched_at,
                        http_status = excluded.http_status,
                        incomplete = 1,
                        snapshot_path = excluded.snapshot_path,
                        description = NULL,
                        topics_json = '[]',
                        language = NULL,
                        html_url = NULL,
                        created_at = NULL,
                        updated_at = NULL,
                        visibility = NULL,
                        archived = NULL,
                        stargazers_count = NULL,
                        forks_count = NULL
                    """,
                    (
                        item.repo_id,
                        item.full_name,
                        etag,
                        now_text,
                        status_code if status_code is not None else 0,
                        None if snapshot_path is None else str(snapshot_path),
                    ),
                )
            self._finish_queue(
                item.repo_id,
                status="failed",
                attempts=attempts,
                permanent=1 if permanent else 0,
                now_text=now_text,
                next_attempt_at=None,
                last_error=error[:500],
                last_status_code=status_code,
            )

    def record_deferred(
        self,
        repo_id: int,
        *,
        attempts: int,
        now: datetime,
        next_attempt_at: str,
        status_code: int | None,
        error: str,
    ) -> None:
        with self._conn:
            self._finish_queue(
                repo_id,
                status="deferred",
                attempts=attempts,
                permanent=0,
                now_text=schemas.format_utc(now),
                next_attempt_at=next_attempt_at,
                last_error=error[:500],
                last_status_code=status_code,
            )

    def _enqueue_one(
        self,
        observed: schemas.ObservedRepo,
        now: datetime,
        now_text: str,
        refresh_after: timedelta,
        retry_after: timedelta,
    ) -> str:
        row = self._conn.execute(
            "SELECT * FROM enrichment_queue WHERE repo_id = ?",
            (observed.repo_id,),
        ).fetchone()
        cache = self._conn.execute(
            "SELECT * FROM metadata_cache WHERE repo_id = ?",
            (observed.repo_id,),
        ).fetchone()
        if (row is not None and row["permanent"]) or (cache is not None and cache["incomplete"]):
            return "skipped_permanent"

        fresh = False
        if cache is not None and not cache["incomplete"]:
            age = now - schemas.parse_utc_iso(str(cache["fetched_at"]))
            fresh = age < refresh_after
        if fresh and (row is None or row["status"] == "succeeded"):
            return "fresh"

        if row is None:
            self._insert_pending(observed, now_text, "missing")
            return "enqueued"
        if row["status"] in ("pending", "deferred"):
            self._conn.execute(
                """
                UPDATE enrichment_queue
                SET full_name = ?, api_url = ?
                WHERE repo_id = ?
                """,
                (observed.full_name, observed.api_url, observed.repo_id),
            )
            return "already_queued"
        if row["status"] == "failed":
            age = now - schemas.parse_utc_iso(str(row["updated_at"]))
            if age < retry_after:
                return "waiting_retry"
            reason = "refresh" if cache is not None and not cache["incomplete"] else "missing"
            self._requeue(observed, now_text, reason)
            return "enqueued"
        if row["status"] == "succeeded":
            self._requeue(observed, now_text, "refresh")
            return "enqueued"
        return "already_queued"

    def _insert_pending(self, observed: schemas.ObservedRepo, now_text: str, reason: str) -> None:
        self._conn.execute(
            """
            INSERT INTO enrichment_queue (
                repo_id, full_name, api_url, status, reason, attempts, permanent,
                enqueued_at, updated_at, next_attempt_at, last_error, last_status_code
            ) VALUES (?, ?, ?, 'pending', ?, 0, 0, ?, ?, NULL, NULL, NULL)
            """,
            (observed.repo_id, observed.full_name, observed.api_url, reason, now_text, now_text),
        )

    def _requeue(self, observed: schemas.ObservedRepo, now_text: str, reason: str) -> None:
        self._conn.execute(
            """
            UPDATE enrichment_queue
            SET full_name = ?, api_url = ?, status = 'pending', reason = ?, attempts = 0,
                permanent = 0, enqueued_at = ?, updated_at = ?, next_attempt_at = NULL,
                last_error = NULL, last_status_code = NULL
            WHERE repo_id = ?
            """,
            (observed.full_name, observed.api_url, reason, now_text, now_text, observed.repo_id),
        )

    def _finish_queue(
        self,
        repo_id: int,
        *,
        status: str,
        attempts: int,
        permanent: int,
        now_text: str,
        next_attempt_at: str | None,
        last_error: str | None,
        last_status_code: int | None,
    ) -> None:
        self._conn.execute(
            """
            UPDATE enrichment_queue
            SET status = ?, attempts = ?, permanent = ?, updated_at = ?,
                next_attempt_at = ?, last_error = ?, last_status_code = ?
            WHERE repo_id = ?
            """,
            (
                status,
                attempts,
                permanent,
                now_text,
                next_attempt_at,
                last_error,
                last_status_code,
                repo_id,
            ),
        )


def drain(
    store: EnrichmentStore,
    *,
    opener: Opener,
    bronze_dir: Path | str,
    now: datetime,
    token: str | None = None,
    max_requests: int = 30,
    min_remaining: int = 5,
    max_attempts: int = 3,
    sleep: Sleeper = time.sleep,
) -> DrainSummary:
    """Process due queue rows until the queue, request cap, or rate limit stops it."""
    if max_requests < 1:
        raise ValueError("max_requests must be >= 1")
    if max_attempts < 1:
        raise ValueError("max_attempts must be >= 1")
    if min_remaining < 0:
        raise ValueError("min_remaining must be >= 0")

    summary = DrainSummary()
    blocked = _budget_block_reason(store.budget(), now, min_remaining)
    if blocked:
        summary.stopped_reason = blocked
        return summary

    root = Path(bronze_dir)
    for item in store.due_items(now, 1_000_000):
        if summary.requests >= max_requests:
            summary.stopped_reason = "max_requests"
            return summary
        blocked = _budget_block_reason(store.budget(), now, min_remaining)
        if blocked:
            summary.stopped_reason = blocked
            return summary
        stop = _process_item(
            store,
            item,
            opener=opener,
            bronze_dir=root,
            now=now,
            token=token,
            max_attempts=max_attempts,
            sleep=sleep,
            summary=summary,
        )
        if stop:
            summary.stopped_reason = stop
            return summary
    return summary


def github_opener(timeout: float) -> Opener:
    """Opener for ``GET https://api.github.com/...`` with a verified TLS context."""
    context = ssl_context()

    def open_request(url: str, method: str, headers: Mapping[str, str]) -> ApiResponse:
        request = urllib.request.Request(
            url,
            method=method,
            headers={str(key): str(value) for key, value in headers.items()},
        )
        try:
            response = urllib.request.urlopen(request, timeout=timeout, context=context)
        except urllib.error.HTTPError as exc:
            body = exc.read() or b""
            normalized = _normalize_headers(exc.headers)
            status = exc.code
            exc.close()
            return ApiResponse(status, normalized, body)
        except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
            raise TransientError(f"{method} {url} failed: {exc}") from exc
        try:
            body = response.read() or b""
            normalized = _normalize_headers(response.headers)
            status = getattr(response, "status", 200)
            return ApiResponse(status, normalized, body)
        finally:
            response.close()

    return open_request


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Drain the GitHub repository enrichment queue.")
    parser.add_argument("--db", default=os.environ.get("ENRICHMENT_DB", "data/enrichment/github.sqlite"))
    parser.add_argument(
        "--api-bronze",
        default=os.environ.get("GITHUB_API_BRONZE_DIR", "data/bronze/github_api"),
    )
    parser.add_argument("--max-requests", type=int, default=30)
    parser.add_argument("--min-remaining", type=int, default=5)
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--status", action="store_true", help="Print queue counts and failures, then exit.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = EnrichmentStore(args.db)
    try:
        if args.status:
            _print_status(store)
            return 0
        token = os.environ.get("GITHUB_TOKEN") or None
        if not token:
            _LOG.warning("GITHUB_TOKEN is not set; the unauthenticated hourly budget is 60 requests")
        summary = drain(
            store,
            opener=github_opener(args.timeout),
            bronze_dir=args.api_bronze,
            now=datetime.now(timezone.utc),
            token=token,
            max_requests=args.max_requests,
            min_remaining=args.min_remaining,
            max_attempts=args.max_attempts,
        )
        _print_summary(summary)
        _print_status(store)
    finally:
        store.close()
    return 0


def _process_item(
    store: EnrichmentStore,
    item: QueueItem,
    *,
    opener: Opener,
    bronze_dir: Path,
    now: datetime,
    token: str | None,
    max_attempts: int,
    sleep: Sleeper,
    summary: DrainSummary,
) -> str:
    attempts = item.attempts
    cache = store.cache_entry(item.repo_id)
    etag = None if cache is None else cache.etag
    while True:
        headers = _request_headers(token, etag)
        try:
            response = opener(item.api_url, "GET", headers)
        except (TransientError, TimeoutError, socket.timeout, OSError) as exc:
            attempts += 1
            if attempts >= max_attempts:
                store.record_failure(
                    item,
                    attempts=attempts,
                    permanent=False,
                    now=now,
                    status_code=None,
                    error=str(exc),
                )
                summary.failed += 1
                return ""
            sleep(min(2 ** (attempts - 1), MAX_BACKOFF_SECONDS))
            continue

        summary.requests += 1
        store.observe_budget(response.headers, now)
        if _is_rate_limited(response.status, response.headers, response.body):
            store.record_deferred(
                item.repo_id,
                attempts=attempts,
                now=now,
                next_attempt_at=schemas.format_utc(_defer_until(now, response.headers)),
                status_code=response.status,
                error=f"HTTP {response.status}",
            )
            summary.deferred += 1
            return "rate_limit"
        if response.status == 304:
            if cache is None:
                store.record_failure(
                    item,
                    attempts=attempts + 1,
                    permanent=False,
                    now=now,
                    status_code=304,
                    error="HTTP 304 without a cached snapshot",
                )
                summary.failed += 1
                return ""
            store.record_not_modified(
                item.repo_id,
                attempts=attempts + 1,
                now=now,
                etag=response.headers.get("etag"),
            )
            summary.not_modified += 1
            return ""
        if response.status == 200:
            metadata = _parse_repository(response.body, item.repo_id, item.full_name)
            if metadata is None:
                attempts += 1
                if attempts >= max_attempts:
                    store.record_failure(
                        item,
                        attempts=attempts,
                        permanent=False,
                        now=now,
                        status_code=200,
                        error="HTTP 200 was not a repository object",
                    )
                    summary.failed += 1
                    return ""
                sleep(min(2 ** (attempts - 1), MAX_BACKOFF_SECONDS))
                continue
            snapshot = _snapshot_path(bronze_dir, item.repo_id, now)
            schemas.atomic_write(snapshot, response.body)
            store.record_success(
                item,
                attempts=attempts + 1,
                now=now,
                snapshot_path=snapshot,
                etag=response.headers.get("etag"),
                metadata=metadata,
            )
            summary.succeeded += 1
            return ""
        if response.status in _TRANSIENT_STATUS or response.status >= 500:
            attempts += 1
            if attempts >= max_attempts:
                store.record_failure(
                    item,
                    attempts=attempts,
                    permanent=False,
                    now=now,
                    status_code=response.status,
                    error=f"HTTP {response.status}",
                )
                summary.failed += 1
                return ""
            sleep(min(2 ** (attempts - 1), MAX_BACKOFF_SECONDS))
            continue

        snapshot = _snapshot_path(bronze_dir, item.repo_id, now)
        schemas.atomic_write(snapshot, response.body)
        store.record_failure(
            item,
            attempts=attempts + 1,
            permanent=True,
            now=now,
            status_code=response.status,
            error=f"HTTP {response.status}",
            snapshot_path=snapshot,
            etag=response.headers.get("etag"),
        )
        summary.failed += 1
        return ""


def _request_headers(token: str | None, etag: str | None) -> dict[str, str]:
    headers = {
        "Accept": API_ACCEPT,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if etag:
        headers["If-None-Match"] = etag
    return headers


def _parse_repository(body: bytes, expected_id: int, fallback_name: str) -> dict[str, object] | None:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or type(payload.get("id")) is not int:
        return None
    if payload["id"] != expected_id:
        return None
    full_name = payload.get("full_name")
    if not isinstance(full_name, str) or not full_name:
        full_name = fallback_name
    topics = payload.get("topics")
    if not isinstance(topics, list):
        topics = []
    visibility = payload.get("visibility")
    if not isinstance(visibility, str):
        if payload.get("private") is True:
            visibility = "private"
        elif payload.get("private") is False:
            visibility = "public"
        else:
            visibility = None
    archived = payload.get("archived")
    return {
        "full_name": full_name,
        "description": payload.get("description") if isinstance(payload.get("description"), str) else None,
        "topics": [topic for topic in topics if isinstance(topic, str)],
        "language": payload.get("language") if isinstance(payload.get("language"), str) else None,
        "html_url": payload.get("html_url") if isinstance(payload.get("html_url"), str) else None,
        "created_at": payload.get("created_at") if isinstance(payload.get("created_at"), str) else None,
        "updated_at": payload.get("updated_at") if isinstance(payload.get("updated_at"), str) else None,
        "visibility": visibility,
        "archived": archived if isinstance(archived, bool) else None,
        "stargazers_count": payload.get("stargazers_count") if type(payload.get("stargazers_count")) is int else None,
        "forks_count": payload.get("forks_count") if type(payload.get("forks_count")) is int else None,
    }


def _is_rate_limited(status: int, headers: Mapping[str, str], body: bytes) -> bool:
    if status == 429:
        return True
    if status != 403:
        return False
    remaining = headers.get("x-ratelimit-remaining", "").strip()
    if remaining == "0":
        return True
    if headers.get("retry-after", "").strip():
        return True
    text = body.decode("utf-8", "replace").lower()
    return "rate limit" in text or "secondary rate" in text


def _defer_until(now: datetime, headers: Mapping[str, str]) -> datetime:
    candidates = []
    retry_after = headers.get("retry-after", "").strip()
    if retry_after.isdigit():
        candidates.append(now + timedelta(seconds=int(retry_after)))
    reset_epoch = _header_int(headers, "x-ratelimit-reset")
    if reset_epoch is not None:
        candidates.append(datetime.fromtimestamp(reset_epoch, tz=timezone.utc))
    if not candidates:
        return now + timedelta(seconds=60)
    deadline = max(candidates)
    if deadline <= now:
        return now + timedelta(seconds=60)
    return deadline


def _budget_block_reason(budget: ApiBudget | None, now: datetime, min_remaining: int) -> str:
    if budget is None or budget.remaining is None:
        return ""
    if budget.reset_at is not None and schemas.parse_utc_iso(budget.reset_at) <= now:
        return ""
    if budget.remaining <= 0:
        return "rate_limit"
    if budget.remaining <= min_remaining:
        return "min_remaining"
    return ""


def _snapshot_path(bronze_dir: Path, repo_id: int, now: datetime) -> Path:
    stamp = schemas.format_utc(now).replace("-", "").replace(":", "")
    return bronze_dir / f"repo_id={repo_id}" / f"fetched_at={stamp}" / "response.json"


def _header_int(headers: Mapping[str, str], name: str) -> int | None:
    raw = headers.get(name)
    if raw is None:
        return None
    text = raw.strip()
    if not text.isdigit():
        return None
    return int(text)


def _bit(value: object) -> int | None:
    if value is True:
        return 1
    if value is False:
        return 0
    return None


def _queue_item(row: sqlite3.Row) -> QueueItem:
    return QueueItem(
        repo_id=int(row["repo_id"]),
        full_name=str(row["full_name"]),
        api_url=str(row["api_url"]),
        status=str(row["status"]),
        reason=str(row["reason"]),
        attempts=int(row["attempts"]),
        permanent=bool(row["permanent"]),
        enqueued_at=str(row["enqueued_at"]),
        updated_at=str(row["updated_at"]),
        next_attempt_at=None if row["next_attempt_at"] is None else str(row["next_attempt_at"]),
        last_error=None if row["last_error"] is None else str(row["last_error"]),
        last_status_code=None if row["last_status_code"] is None else int(row["last_status_code"]),
    )


def _cache_entry(row: sqlite3.Row) -> CacheEntry:
    archived = row["archived"]
    return CacheEntry(
        repo_id=int(row["repo_id"]),
        full_name=str(row["full_name"]),
        etag=None if row["etag"] is None else str(row["etag"]),
        fetched_at=str(row["fetched_at"]),
        http_status=int(row["http_status"]),
        incomplete=bool(row["incomplete"]),
        snapshot_path=None if row["snapshot_path"] is None else str(row["snapshot_path"]),
        description=None if row["description"] is None else str(row["description"]),
        topics=_topics(str(row["topics_json"])),
        language=None if row["language"] is None else str(row["language"]),
        html_url=None if row["html_url"] is None else str(row["html_url"]),
        created_at=None if row["created_at"] is None else str(row["created_at"]),
        updated_at=None if row["updated_at"] is None else str(row["updated_at"]),
        visibility=None if row["visibility"] is None else str(row["visibility"]),
        archived=None if archived is None else bool(archived),
        stargazers_count=None if row["stargazers_count"] is None else int(row["stargazers_count"]),
        forks_count=None if row["forks_count"] is None else int(row["forks_count"]),
    )


def _topics(payload: str) -> tuple[str, ...]:
    try:
        loaded = json.loads(payload)
    except json.JSONDecodeError:
        return ()
    if not isinstance(loaded, list):
        return ()
    return tuple(item for item in loaded if isinstance(item, str))


def _print_summary(summary: DrainSummary) -> None:
    reason = summary.stopped_reason or "-"
    print(
        "enrichment "
        f"succeeded={summary.succeeded} not_modified={summary.not_modified} "
        f"failed={summary.failed} deferred={summary.deferred} "
        f"requests={summary.requests} stopped={reason}"
    )


def _print_status(store: EnrichmentStore) -> None:
    counts = store.queue_counts()
    if counts:
        rendered = " ".join(f"{status}={count}" for status, count in sorted(counts.items()))
    else:
        rendered = "empty"
    budget = store.budget()
    if budget is None or budget.remaining is None:
        budget_text = "remaining=unknown"
    else:
        budget_text = f"remaining={budget.remaining} reset={budget.reset_at or '-'}"
    print(f"queue {rendered}  {budget_text}")
    for failure in store.list_failures():
        print(
            f"failure repo_id={failure.repo_id} permanent={int(failure.permanent)} "
            f"attempts={failure.attempts} {failure.last_error or ''}"
        )


if __name__ == "__main__":
    raise SystemExit(main())
