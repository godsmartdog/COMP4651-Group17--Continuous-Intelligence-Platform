"""Download hourly GH Archive dumps into the Bronze layer.

GH Archive publishes one gzipped JSONL file per UTC hour. The hour is not
zero-padded:

    https://data.gharchive.org/YYYY-MM-DD-H.json.gz

Each line of the decompressed file is one GitHub event. This script stores
those files unchanged so a later Silver job can replay them:

    {output}/year=YYYY/month=MM/day=DD/hour=HH/YYYY-MM-DD-H.json.gz

Re-running a window is idempotent. A local file is kept when it is gzip and
its size matches the remote Content-Length. Downloads go to a sibling
``.partial`` file and replace the destination only after the body is complete.

Examples:
    python fetch_gh_archive.py --hours 6
    python fetch_gh_archive.py --start 2024-01-01
    python fetch_gh_archive.py --start 2024-01-01 --end 2024-01-03
    python fetch_gh_archive.py --start 2024-01-01T15:00:00Z
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import logging
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Callable, Iterable, Mapping

DEFAULT_BASE_URL = "https://data.gharchive.org"
USER_AGENT = "GitPulse-COMP4651/1.0 (educational; group 17)"
RETRYABLE_STATUS = {403, 408, 429, 500, 502, 503, 504}
_SYSTEM_CA_FILES = (
    "/etc/ssl/cert.pem",
    "/opt/homebrew/etc/ca-certificates/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
)
_DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_LOG = logging.getLogger("fetch_gh_archive")

Opener = Callable[[str, str], "HttpResponse"]
Sleeper = Callable[[float], None]


class FetchStatus(str, Enum):
    DOWNLOADED = "downloaded"
    SKIPPED = "skipped"
    MISSING = "missing"
    FAILED = "failed"


class TransientError(Exception):
    """Retryable network or integrity failure."""


class PermanentError(Exception):
    """HTTP failure that will not succeed on retry."""


@dataclass(frozen=True)
class HourResult:
    hour: datetime
    status: FetchStatus
    path: Path | None
    bytes_written: int = 0
    detail: str = ""


class HttpResponse:
    """Small response wrapper so tests can fake HEAD and streaming GET."""

    def __init__(self, status: int, headers: Mapping[str, str], body: bytes = b""):
        self.status = status
        self.headers = {key.lower(): value for key, value in headers.items()}
        self._body = body
        self._closed = False

    def iter_chunks(self, size: int = 1024 * 1024) -> Iterable[bytes]:
        view = self._body
        for offset in range(0, len(view), size):
            yield view[offset : offset + size]

    def close(self) -> None:
        self._closed = True


def archive_name(hour: datetime) -> str:
    """Return the GH Archive object name. Hour is 0-23 with no zero padding."""
    floored = _as_utc_hour(hour)
    return f"{floored:%Y-%m-%d}-{floored.hour}.json.gz"


def archive_url(hour: datetime, base_url: str = DEFAULT_BASE_URL) -> str:
    return f"{base_url.rstrip('/')}/{archive_name(hour)}"


def bronze_destination(output_dir: Path | str, hour: datetime) -> Path:
    """Hive-style bronze path. The hour partition is zero-padded; the filename is not."""
    floored = _as_utc_hour(hour)
    return (
        Path(output_dir)
        / f"year={floored:%Y}"
        / f"month={floored:%m}"
        / f"day={floored:%d}"
        / f"hour={floored:%H}"
        / archive_name(floored)
    )


def parse_utc(value: str) -> tuple[datetime, bool]:
    """Parse a UTC timestamp. Returns (datetime, is_date_only)."""
    text = value.strip()
    if _DATE_ONLY.fullmatch(text):
        year, month, day = (int(part) for part in text.split("-"))
        return datetime(year, month, day, tzinfo=timezone.utc), True
    normalized = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed, False


def resolve_window(
    start: str | None,
    end: str | None,
    hours: int | None,
    now: datetime,
) -> tuple[datetime, datetime]:
    """Return a half-open UTC hour window [start, end).

    --hours counts back from the current hour, which is still incomplete on
    GH Archive, so that hour is excluded. A date-only --end is exclusive.
    """
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(timezone.utc)
    if hours is not None and (start is not None or end is not None):
        raise ValueError("--hours cannot be combined with --start or --end")
    if hours is not None:
        if hours < 1:
            raise ValueError("--hours must be >= 1")
        end_hour = now.replace(minute=0, second=0, microsecond=0)
        return end_hour - timedelta(hours=hours), end_hour
    if start is None:
        raise ValueError("provide --start or --hours")

    start_dt, start_is_date = parse_utc(start)
    if end is None:
        if start_is_date:
            day = start_dt.replace(minute=0, second=0, microsecond=0)
            return day, day + timedelta(days=1)
        start_hour = _as_utc_hour(start_dt)
        return start_hour, start_hour + timedelta(hours=1)

    end_dt, _end_is_date = parse_utc(end)
    start_hour = _as_utc_hour(start_dt)
    end_hour = _as_utc_hour(end_dt)
    if end_hour <= start_hour:
        raise ValueError(
            f"empty hour range: {start_hour.isoformat()} .. {end_hour.isoformat()}"
        )
    return start_hour, end_hour


def iter_hours(start: datetime, end: datetime) -> list[datetime]:
    """Yield UTC hours in [start, end), after flooring both bounds to the hour."""
    start_hour = _as_utc_hour(start)
    end_hour = _as_utc_hour(end)
    if end_hour <= start_hour:
        raise ValueError(
            f"empty hour range: {start_hour.isoformat()} .. {end_hour.isoformat()}"
        )
    hours = []
    cursor = start_hour
    while cursor < end_hour:
        hours.append(cursor)
        cursor += timedelta(hours=1)
    return hours


def fetch_hour(
    hour: datetime,
    output_dir: Path | str,
    *,
    opener: Opener | None = None,
    base_url: str = DEFAULT_BASE_URL,
    retries: int = 3,
    timeout: float = 180,
    sleep: Sleeper = time.sleep,
) -> HourResult:
    """Download one hour, or skip it when the bronze file is already complete."""
    if retries < 1:
        raise ValueError("retries must be >= 1")
    client = opener or urllib_opener(timeout)
    dest = bronze_destination(output_dir, hour)
    partial = _partial_path(dest)
    last_error = "unknown error"
    for attempt in range(1, retries + 1):
        try:
            return _fetch_once(hour, dest, partial, client, base_url)
        except PermanentError as exc:
            _remove(partial)
            return HourResult(hour, FetchStatus.FAILED, None, 0, str(exc))
        except (TransientError, TimeoutError, socket.timeout, OSError) as exc:
            last_error = str(exc)
            _remove(partial)
            if attempt == retries:
                break
            sleep(min(2 ** (attempt - 1), 30))
    return HourResult(hour, FetchStatus.FAILED, None, 0, last_error)


def fetch_range(
    start: datetime,
    end: datetime,
    output_dir: Path | str,
    *,
    opener: Opener | None = None,
    base_url: str = DEFAULT_BASE_URL,
    retries: int = 3,
    timeout: float = 180,
    workers: int = 4,
    sleep: Sleeper = time.sleep,
) -> list[HourResult]:
    """Download every hour in [start, end). Results are ordered by hour."""
    if workers < 1:
        raise ValueError("workers must be >= 1")
    hours = iter_hours(start, end)
    kwargs = {
        "opener": opener,
        "base_url": base_url,
        "retries": retries,
        "timeout": timeout,
        "sleep": sleep,
    }
    if workers == 1 or len(hours) <= 1:
        return [fetch_hour(hour, output_dir, **kwargs) for hour in hours]
    with ThreadPoolExecutor(max_workers=min(workers, len(hours))) as pool:
        futures = [pool.submit(fetch_hour, hour, output_dir, **kwargs) for hour in hours]
        results = [future.result() for future in futures]
    results.sort(key=lambda item: item.hour)
    return results


def summarize(results: Iterable[HourResult]) -> dict[str, int]:
    counts = {status.value: 0 for status in FetchStatus}
    for result in results:
        counts[result.status.value] += 1
    return counts


def ssl_context() -> ssl.SSLContext:
    """Verified TLS context.

    python.org macOS installs often ship without a CA bundle, so the default
    context cannot verify data.gharchive.org. Fall back to the system bundle
    and keep certificate checks enabled.
    """
    paths = ssl.get_default_verify_paths()
    if paths.cafile and Path(paths.cafile).is_file():
        return ssl.create_default_context()
    for candidate in _SYSTEM_CA_FILES:
        if Path(candidate).is_file():
            return ssl.create_default_context(cafile=candidate)
    return ssl.create_default_context()


def urllib_opener(timeout: float) -> Opener:
    """Opener backed by urllib. HEAD responses have an empty body."""
    context = ssl_context()

    def open_request(url: str, method: str) -> HttpResponse:
        request = urllib.request.Request(
            url,
            method=method,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/gzip, application/octet-stream, */*",
            },
        )
        try:
            response = urllib.request.urlopen(request, timeout=timeout, context=context)
        except urllib.error.HTTPError as exc:
            headers = _normalize_headers(exc.headers)
            exc.close()
            return HttpResponse(exc.code, headers)
        except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
            raise TransientError(f"{method} {url} failed: {exc}") from exc

        headers = _normalize_headers(response.headers)
        status = getattr(response, "status", 200)
        if method == "HEAD":
            response.close()
            return HttpResponse(status, headers)
        return _StreamingResponse(status, headers, response)

    return open_request


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Download hourly GH Archive files into the Bronze layer.",
    )
    parser.add_argument(
        "--start",
        help="UTC start (YYYY-MM-DD or ISO-8601). A date alone means that whole UTC day.",
    )
    parser.add_argument(
        "--end",
        help="UTC end, exclusive after flooring to the hour. A date alone is that midnight.",
    )
    parser.add_argument(
        "--hours",
        type=int,
        help="Fetch this many most recently completed UTC hours.",
    )
    parser.add_argument(
        "--output",
        default=os.environ.get("GH_ARCHIVE_BRONZE_DIR", "data/bronze/gharchive"),
        help="Bronze root. Defaults to $GH_ARCHIVE_BRONZE_DIR or data/bronze/gharchive.",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("GH_ARCHIVE_BASE_URL", DEFAULT_BASE_URL),
    )
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=180)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        start, end = resolve_window(
            args.start,
            args.end,
            args.hours,
            datetime.now(timezone.utc),
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _LOG.info(
        "fetching %s .. %s into %s",
        start.strftime("%Y-%m-%d %H:%MZ"),
        end.strftime("%Y-%m-%d %H:%MZ"),
        args.output,
    )
    results = fetch_range(
        start,
        end,
        args.output,
        base_url=args.base_url,
        retries=args.retries,
        timeout=args.timeout,
        workers=args.workers,
    )
    for result in results:
        stamp = result.hour.strftime("%Y-%m-%d %H:%MZ")
        location = result.path if result.path is not None else "-"
        suffix = f"  {result.detail}" if result.detail and result.status != FetchStatus.DOWNLOADED else ""
        print(f"{stamp}  {result.status.value:<12}{result.bytes_written:>12}  {location}{suffix}")
    counts = summarize(results)
    print(
        "downloaded={downloaded} skipped={skipped} missing={missing} failed={failed}".format(
            **counts
        )
    )
    return 1 if counts["failed"] else 0


class _StreamingResponse(HttpResponse):
    def __init__(self, status: int, headers: Mapping[str, str], stream):
        super().__init__(status, headers)
        self._stream = stream

    def iter_chunks(self, size: int = 1024 * 1024) -> Iterable[bytes]:
        while True:
            chunk = self._stream.read(size)
            if not chunk:
                break
            yield chunk

    def close(self) -> None:
        self._stream.close()


def _fetch_once(
    hour: datetime,
    dest: Path,
    partial: Path,
    opener: Opener,
    base_url: str,
) -> HourResult:
    url = archive_url(hour, base_url)
    head = opener(url, "HEAD")
    try:
        if head.status == 404:
            return HourResult(hour, FetchStatus.MISSING, None, 0, "not published")
        _raise_for_retry(head.status, url, "HEAD")
        expected_len = _content_length(head.headers)
        expected_md5 = _expected_md5(head.headers)
        if _local_matches(dest, expected_len):
            return HourResult(
                hour,
                FetchStatus.SKIPPED,
                dest,
                dest.stat().st_size,
                "already present",
            )
    finally:
        head.close()

    body = opener(url, "GET")
    try:
        if body.status == 404:
            return HourResult(hour, FetchStatus.MISSING, None, 0, "not published")
        _raise_for_retry(body.status, url, "GET")
        get_len = _content_length(body.headers)
        get_md5 = _expected_md5(body.headers) or expected_md5
        dest.parent.mkdir(parents=True, exist_ok=True)
        written = _write_stream(body, partial)
    except Exception:
        _remove(partial)
        raise
    finally:
        body.close()

    _verify_download(partial, url, written, expected_len, get_len, get_md5)
    os.replace(partial, dest)
    return HourResult(hour, FetchStatus.DOWNLOADED, dest, written, "downloaded")


def _verify_download(
    partial: Path,
    url: str,
    written: int,
    expected_len: int | None,
    get_len: int | None,
    expected_md5: bytes | None,
) -> None:
    if expected_len is not None and written != expected_len:
        _remove(partial)
        raise TransientError(f"short read for {url}: {written} != {expected_len}")
    if get_len is not None and written != get_len:
        _remove(partial)
        raise TransientError(f"short read for {url}: {written} != {get_len}")
    if not _is_gzip(partial):
        _remove(partial)
        raise TransientError(f"response for {url} is not gzip")
    if expected_md5 is not None and _md5_file(partial) != expected_md5:
        _remove(partial)
        raise TransientError(f"md5 mismatch for {url}")


def _raise_for_retry(status: int, url: str, method: str) -> None:
    if status in RETRYABLE_STATUS:
        raise TransientError(f"{method} {url} -> HTTP {status}")
    if status >= 400:
        raise PermanentError(f"{method} {url} -> HTTP {status}")


def _write_stream(response: HttpResponse, partial: Path) -> int:
    written = 0
    with partial.open("wb") as handle:
        for chunk in response.iter_chunks():
            if not chunk:
                continue
            handle.write(chunk)
            written += len(chunk)
        handle.flush()
        os.fsync(handle.fileno())
    return written


def _local_matches(dest: Path, expected_len: int | None) -> bool:
    if not dest.is_file():
        return False
    size = dest.stat().st_size
    if size <= 0 or not _is_gzip(dest):
        return False
    if expected_len is None:
        return True
    return size == expected_len


def _is_gzip(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(2) == b"\x1f\x8b"
    except OSError:
        return False


def _md5_file(path: Path) -> bytes:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def _content_length(headers: Mapping[str, str]) -> int | None:
    raw = headers.get("content-length")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _expected_md5(headers: Mapping[str, str]) -> bytes | None:
    for part in re.split(r"[\n,]", headers.get("x-goog-hash", "")):
        piece = part.strip()
        if not piece.lower().startswith("md5="):
            continue
        encoded = piece.split("=", 1)[1].strip()
        try:
            return base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            return None
    return None


def _normalize_headers(headers) -> dict[str, str]:
    if headers is None:
        return {}
    merged: dict[str, str] = {}
    names = list(headers.keys()) if hasattr(headers, "keys") else []
    for name in names:
        if not name:
            continue
        if hasattr(headers, "get_all"):
            values = headers.get_all(name) or []
        else:
            values = [headers.get(name)]
        merged[name.lower()] = ",".join(str(value) for value in values if value is not None)
    return merged


def _partial_path(dest: Path) -> Path:
    return Path(str(dest) + ".partial")


def _remove(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return


def _as_utc_hour(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("naive datetimes are not accepted; use UTC")
    return value.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


if __name__ == "__main__":
    raise SystemExit(main())
