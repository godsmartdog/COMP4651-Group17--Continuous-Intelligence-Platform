"""Canonical Phase 1 records for bronze ingestion.

The hourly job writes three kinds of bronze data:

- ``manifest.json`` beside each GH Archive hour. It records the archive hour,
  source URL, byte size, sha256, fetch status, and parse counts.
- ``repos.jsonl`` beside that hour. One line per repository observed in the
  file, with ``repo_id``, ``full_name``, ``api_url``, and ``event_count``.
- ``response.json`` under the GitHub API bronze root, one raw response body
  per fetch. A 304 does not create another snapshot.

Operational queue, cache, and rate-limit state live in SQLite because those
rows are updated in place. The JSON artifacts above are the replay source.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping


MANIFEST_VERSION = 1
MANIFEST_FILENAME = "manifest.json"
REPOS_FILENAME = "repos.jsonl"
GITHUB_API_BASE = "https://api.github.com"


def format_utc(value: datetime) -> str:
    """Format an aware datetime as UTC ``YYYY-MM-DDTHH:MM:SSZ``."""
    if value.tzinfo is None:
        raise ValueError("naive datetimes are not accepted; use UTC")
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc_iso(value: str) -> datetime:
    """Parse a UTC timestamp produced by :func:`format_utc`."""
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("naive datetimes are not accepted; use UTC")
    return parsed.astimezone(timezone.utc)


def repository_url(repo_id: int, api_base: str = GITHUB_API_BASE) -> str:
    """Stable GitHub API URL. Numeric ids survive repository renames."""
    return f"{api_base.rstrip('/')}/repositories/{repo_id}"


def atomic_write(path: Path | str, data: bytes) -> None:
    """Write ``path`` via a sibling ``.partial`` file, then replace it."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = Path(str(destination) + ".partial")
    try:
        with partial.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(partial, destination)
    except Exception:
        try:
            partial.unlink()
        except FileNotFoundError:
            pass
        raise


@dataclass(frozen=True)
class ObservedRepo:
    """One repository observed inside a single archive hour."""

    repo_id: int
    full_name: str
    api_url: str
    event_count: int

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, object]) -> "ObservedRepo":
        return cls(
            repo_id=int(data["repo_id"]),
            full_name=str(data["full_name"]),
            api_url=str(data["api_url"]),
            event_count=int(data["event_count"]),
        )


@dataclass(frozen=True)
class IngestionManifest:
    """Completion record for one GH Archive hour.

    ``fetch_status`` uses the downloader's values: downloaded, skipped,
    missing, or failed. Parse counts are zero when no archive file exists.
    ``sha256`` is the lowercase hex digest of the raw gzip bytes, or empty
    when the hour was missing or the download failed.
    """

    manifest_version: int
    archive_hour: str
    source_url: str
    bronze_path: str
    size_bytes: int
    sha256: str
    fetch_status: str
    event_count: int
    malformed_count: int
    missing_repo_count: int
    repo_count: int
    ingested_at: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, object]) -> "IngestionManifest":
        version = int(data["manifest_version"])
        if version != MANIFEST_VERSION:
            raise ValueError(f"unsupported manifest version: {version}")
        return cls(
            manifest_version=version,
            archive_hour=str(data["archive_hour"]),
            source_url=str(data["source_url"]),
            bronze_path=str(data["bronze_path"]),
            size_bytes=int(data["size_bytes"]),
            sha256=str(data["sha256"]),
            fetch_status=str(data["fetch_status"]),
            event_count=int(data["event_count"]),
            malformed_count=int(data["malformed_count"]),
            missing_repo_count=int(data["missing_repo_count"]),
            repo_count=int(data["repo_count"]),
            ingested_at=str(data["ingested_at"]),
        )


def write_manifest(path: Path | str, manifest: IngestionManifest) -> None:
    payload = json.dumps(manifest.to_dict(), indent=2, sort_keys=True).encode("utf-8") + b"\n"
    atomic_write(path, payload)


def read_manifest(path: Path | str) -> IngestionManifest:
    return IngestionManifest.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
