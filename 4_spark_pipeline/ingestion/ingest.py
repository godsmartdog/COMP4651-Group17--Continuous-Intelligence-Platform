"""Phase 1 hourly ingestion.

One run, for each hour in the window:

1. Download the GH Archive file, or skip it when the bronze gzip is already complete.
2. Write ``manifest.json`` with the archive hour, source URL, size, sha256, and status.
3. Extract observed repository ids into ``repos.jsonl``.
4. Enqueue GitHub metadata requests that are missing or due for refresh.
5. Optionally drain that queue with caching, bounded retries, and a request budget.

Re-running a window does not duplicate queue rows or rewrite a complete archive.
Missing and failed hours still get a manifest so the gap is visible.

Examples:
    python ingest.py --hours 1
    python ingest.py --start 2024-01-01T00:00:00Z --end 2024-01-01T02:00:00Z
    python ingest.py --hours 1 --enrich --max-requests 30
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import extract_repos
import fetch_gh_archive as gh
import github_api
import schemas


_LOG = logging.getLogger("ingest")


@dataclass(frozen=True)
class HourReport:
    result: gh.HourResult
    manifest: schemas.IngestionManifest
    manifest_path: Path
    repos_path: Path | None
    enqueue: github_api.EnqueueResult


@dataclass(frozen=True)
class IngestReport:
    hours: tuple[HourReport, ...]
    enqueue: github_api.EnqueueResult
    enrichment: github_api.DrainSummary | None


def sha256_file(path: Path | str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def record_hour(
    result: gh.HourResult,
    output_dir: Path | str,
    store: github_api.EnrichmentStore,
    *,
    now: datetime,
    archive_base_url: str,
    api_base: str,
    refresh_after: timedelta,
    retry_after: timedelta,
) -> HourReport:
    """Write the bronze manifest and enqueue repositories for one fetch result."""
    archive_path = result.path if result.path is not None else gh.bronze_destination(output_dir, result.hour)
    manifest_path = archive_path.parent / schemas.MANIFEST_FILENAME
    repos_path = None
    enqueue = github_api.EnqueueResult()
    if result.status in (gh.FetchStatus.DOWNLOADED, gh.FetchStatus.SKIPPED) and result.path is not None:
        extraction = extract_repos.extract_repos(result.path, api_base=api_base)
        repos_path = archive_path.parent / schemas.REPOS_FILENAME
        extract_repos.write_repos(repos_path, extraction.repos)
        manifest = _manifest(
            result,
            archive_path=result.path,
            source_url=gh.archive_url(result.hour, archive_base_url),
            size_bytes=result.path.stat().st_size,
            sha256=sha256_file(result.path),
            event_count=extraction.event_count,
            malformed_count=extraction.malformed_count,
            missing_repo_count=extraction.missing_repo_count,
            repo_count=len(extraction.repos),
            now=now,
        )
        schemas.write_manifest(manifest_path, manifest)
        enqueue = store.enqueue(
            extraction.repos,
            now=now,
            refresh_after=refresh_after,
            retry_after=retry_after,
        )
    else:
        manifest = _manifest(
            result,
            archive_path=archive_path,
            source_url=gh.archive_url(result.hour, archive_base_url),
            size_bytes=0,
            sha256="",
            event_count=0,
            malformed_count=0,
            missing_repo_count=0,
            repo_count=0,
            now=now,
        )
        schemas.write_manifest(manifest_path, manifest)
    return HourReport(result, manifest, manifest_path, repos_path, enqueue)


def ingest_window(
    start: datetime,
    end: datetime,
    output_dir: Path | str,
    *,
    store: github_api.EnrichmentStore,
    opener: gh.Opener | None = None,
    base_url: str = gh.DEFAULT_BASE_URL,
    api_base: str = schemas.GITHUB_API_BASE,
    api_bronze: Path | str = "data/bronze/github_api",
    now: datetime,
    refresh_after: timedelta,
    retry_after: timedelta,
    enrich: bool = False,
    token: str | None = None,
    max_requests: int = 30,
    min_remaining: int = 5,
    max_attempts: int = 3,
    retries: int = 3,
    timeout: float = 180,
    workers: int = 4,
    sleep: gh.Sleeper = time.sleep,
) -> IngestReport:
    """Download a half-open hour window, record manifests, and enqueue enrichment."""
    results = gh.fetch_range(
        start,
        end,
        output_dir,
        opener=opener,
        base_url=base_url,
        retries=retries,
        timeout=timeout,
        workers=workers,
        sleep=sleep,
    )
    hours = []
    totals = github_api.EnqueueResult()
    for result in results:
        report = record_hour(
            result,
            output_dir,
            store,
            now=now,
            archive_base_url=base_url,
            api_base=api_base,
            refresh_after=refresh_after,
            retry_after=retry_after,
        )
        hours.append(report)
        totals = totals.add(report.enqueue)

    enrichment = None
    if enrich:
        enrichment = github_api.drain(
            store,
            opener=github_api.github_opener(timeout),
            bronze_dir=api_bronze,
            now=now,
            token=token,
            max_requests=max_requests,
            min_remaining=min_remaining,
            max_attempts=max_attempts,
            sleep=sleep,
        )
    return IngestReport(tuple(hours), totals, enrichment)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ingest GH Archive hours and queue GitHub metadata.")
    parser.add_argument("--start", help="UTC start (YYYY-MM-DD or ISO-8601).")
    parser.add_argument("--end", help="UTC end, exclusive after flooring to the hour.")
    parser.add_argument("--hours", type=int, help="Ingest this many most recently completed UTC hours.")
    parser.add_argument(
        "--output",
        default=os.environ.get("GH_ARCHIVE_BRONZE_DIR", "data/bronze/gharchive"),
        help="GH Archive bronze root.",
    )
    parser.add_argument("--base-url", default=os.environ.get("GH_ARCHIVE_BASE_URL", gh.DEFAULT_BASE_URL))
    parser.add_argument("--api-base", default=os.environ.get("GITHUB_API_BASE", schemas.GITHUB_API_BASE))
    parser.add_argument(
        "--api-bronze",
        default=os.environ.get("GITHUB_API_BRONZE_DIR", "data/bronze/github_api"),
    )
    parser.add_argument("--db", default=os.environ.get("ENRICHMENT_DB", "data/enrichment/github.sqlite"))
    parser.add_argument("--refresh-hours", type=float, default=24)
    parser.add_argument("--retry-hours", type=float, default=1)
    parser.add_argument("--enrich", action="store_true", help="Drain the GitHub API queue after enqueueing.")
    parser.add_argument("--max-requests", type=int, default=30)
    parser.add_argument("--min-remaining", type=int, default=5)
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=180)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        start, end = gh.resolve_window(args.start, args.end, args.hours, datetime.now(timezone.utc))
        _validate_args(args)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    token = os.environ.get("GITHUB_TOKEN") or None
    if args.enrich and not token:
        _LOG.warning("GITHUB_TOKEN is not set; the unauthenticated hourly budget is 60 requests")
    _LOG.info(
        "ingesting %s .. %s into %s",
        start.strftime("%Y-%m-%d %H:%MZ"),
        end.strftime("%Y-%m-%d %H:%MZ"),
        args.output,
    )
    store = github_api.EnrichmentStore(args.db)
    try:
        report = ingest_window(
            start,
            end,
            args.output,
            store=store,
            base_url=args.base_url,
            api_base=args.api_base,
            api_bronze=args.api_bronze,
            now=datetime.now(timezone.utc),
            refresh_after=timedelta(hours=args.refresh_hours),
            retry_after=timedelta(hours=args.retry_hours),
            enrich=args.enrich,
            token=token,
            max_requests=args.max_requests,
            min_remaining=args.min_remaining,
            max_attempts=args.max_attempts,
            retries=args.retries,
            timeout=args.timeout,
            workers=args.workers,
        )
    finally:
        store.close()

    _print_report(report)
    failed = any(hour.result.status == gh.FetchStatus.FAILED for hour in report.hours)
    return 1 if failed else 0


def _manifest(
    result: gh.HourResult,
    *,
    archive_path: Path,
    source_url: str,
    size_bytes: int,
    sha256: str,
    event_count: int,
    malformed_count: int,
    missing_repo_count: int,
    repo_count: int,
    now: datetime,
) -> schemas.IngestionManifest:
    return schemas.IngestionManifest(
        manifest_version=schemas.MANIFEST_VERSION,
        archive_hour=schemas.format_utc(result.hour),
        source_url=source_url,
        bronze_path=str(archive_path),
        size_bytes=size_bytes,
        sha256=sha256,
        fetch_status=result.status.value,
        event_count=event_count,
        malformed_count=malformed_count,
        missing_repo_count=missing_repo_count,
        repo_count=repo_count,
        ingested_at=schemas.format_utc(now),
    )


def _validate_args(args: argparse.Namespace) -> None:
    if args.refresh_hours < 0 or args.retry_hours < 0:
        raise ValueError("refresh and retry hours must be >= 0")
    if args.max_requests < 1 or args.max_attempts < 1 or args.retries < 1 or args.workers < 1:
        raise ValueError("request, attempt, retry, and worker counts must be >= 1")
    if args.min_remaining < 0:
        raise ValueError("min remaining must be >= 0")


def _print_report(report: IngestReport) -> None:
    for hour in report.hours:
        stamp = hour.result.hour.strftime("%Y-%m-%d %H:%MZ")
        print(
            f"{stamp}  {hour.manifest.fetch_status:<12}"
            f"events={hour.manifest.event_count:<8}"
            f"repos={hour.manifest.repo_count:<8}"
            f"{hour.manifest.sha256 or '-':<64}  {hour.manifest_path}"
        )
    counts = gh.summarize(hour.result for hour in report.hours)
    print(
        "downloaded={downloaded} skipped={skipped} missing={missing} failed={failed}".format(**counts)
    )
    queued = report.enqueue
    print(
        "enqueued={enqueued} already_queued={already_queued} fresh={fresh} "
        "waiting_retry={waiting_retry} skipped_permanent={skipped_permanent}".format(
            enqueued=queued.enqueued,
            already_queued=queued.already_queued,
            fresh=queued.fresh,
            waiting_retry=queued.waiting_retry,
            skipped_permanent=queued.skipped_permanent,
        )
    )
    if report.enrichment is not None:
        github_api._print_summary(report.enrichment)


if __name__ == "__main__":
    raise SystemExit(main())
