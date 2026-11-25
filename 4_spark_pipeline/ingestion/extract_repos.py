"""Extract repository ids observed in one GH Archive hour.

GH Archive stores one GitHub event per line. The repository identity used by
enrichment is ``repo.id``. ``repo.name`` is the ``owner/name`` string at the
time of the event. Lines that are not JSON are counted as malformed. Parsed
events without a positive repository id are counted separately and are not
enqueued.
"""

from __future__ import annotations

import gzip
import json
import zlib
from dataclasses import dataclass
from pathlib import Path

import schemas


@dataclass(frozen=True)
class Extraction:
    repos: tuple[schemas.ObservedRepo, ...]
    event_count: int
    malformed_count: int
    missing_repo_count: int


def extract_repos(path: Path | str, api_base: str = schemas.GITHUB_API_BASE) -> Extraction:
    """Stream a bronze gzip file and return repositories sorted by id."""
    archive = Path(path)
    with archive.open("rb") as handle:
        if handle.read(2) != b"\x1f\x8b":
            raise ValueError(f"{archive} is not a gzip archive")

    found: dict[int, list[object]] = {}
    event_count = 0
    malformed_count = 0
    missing_repo_count = 0
    try:
        with gzip.open(archive, "rb") as handle:
            for raw in handle:
                try:
                    line = raw.decode("utf-8").strip()
                except UnicodeDecodeError:
                    malformed_count += 1
                    continue
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    malformed_count += 1
                    continue
                if not isinstance(record, dict):
                    malformed_count += 1
                    continue
                event_count += 1
                repo = record.get("repo")
                repo_id = _repo_id(repo)
                if repo_id is None:
                    missing_repo_count += 1
                    continue
                full_name = ""
                if isinstance(repo, dict) and isinstance(repo.get("name"), str):
                    full_name = repo["name"]
                slot = found.get(repo_id)
                if slot is None:
                    found[repo_id] = [full_name, schemas.repository_url(repo_id, api_base), 1]
                else:
                    slot[2] = int(slot[2]) + 1
    except (gzip.BadGzipFile, zlib.error, EOFError) as exc:
        raise ValueError(f"{archive} is not a gzip archive") from exc

    repos = tuple(
        schemas.ObservedRepo(repo_id, str(full_name), str(api_url), int(event_count_for_repo))
        for repo_id, (full_name, api_url, event_count_for_repo) in sorted(found.items())
    )
    return Extraction(repos, event_count, malformed_count, missing_repo_count)


def write_repos(path: Path | str, repos: tuple[schemas.ObservedRepo, ...] | list[schemas.ObservedRepo]) -> None:
    """Write repository lines sorted by id. Repeating the call is byte-stable."""
    ordered = sorted(repos, key=lambda item: item.repo_id)
    lines = [
        json.dumps(item.to_dict(), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        for item in ordered
    ]
    payload = (("\n".join(lines) + "\n") if lines else "").encode("utf-8")
    schemas.atomic_write(path, payload)


def read_repos(path: Path | str) -> list[schemas.ObservedRepo]:
    repos = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        repos.append(schemas.ObservedRepo.from_dict(json.loads(line)))
    return repos


def _repo_id(repo: object) -> int | None:
    if not isinstance(repo, dict):
        return None
    value = repo.get("id")
    if type(value) is int and value > 0:
        return value
    if isinstance(value, str) and value.isdigit() and int(value) > 0:
        return int(value)
    return None
