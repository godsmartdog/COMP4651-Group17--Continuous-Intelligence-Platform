"""Turn one GH Archive line into a canonical event or a rejection.

A blank line returns ``None`` and is not quarantined. The first failed rule
is the rejection reason.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import extract_repos
import schemas


EVENT_COLUMNS = (
    "event_id",
    "repo_id",
    "event_type",
    "event_time",
    "archive_hour",
    "ingested_at",
    "actor_id",
    "actor_login",
    "repo_name",
    "payload_action",
    "source_path",
)

REJECT_COLUMNS = (
    "reason",
    "source_path",
    "archive_hour",
    "line_no",
    "excerpt",
)

_EXCERPT_CHARS = 500


@dataclass(frozen=True)
class CanonicalEvent:
    """One validated GH Archive event."""

    event_id: str
    repo_id: int
    event_type: str
    event_time: str
    archive_hour: str
    ingested_at: str
    actor_id: int | None
    actor_login: str | None
    repo_name: str
    payload_action: str | None
    source_path: str

    def to_row(self) -> tuple[object, ...]:
        return tuple(getattr(self, name) for name in EVENT_COLUMNS)


@dataclass(frozen=True)
class RejectedEvent:
    """One line that failed validation. ``reason`` is the first failure."""

    reason: str
    source_path: str
    archive_hour: str
    line_no: int
    excerpt: str

    def to_row(self) -> tuple[object, ...]:
        return tuple(getattr(self, name) for name in REJECT_COLUMNS)


def parse_line(
    line: str,
    *,
    archive_hour: str,
    ingested_at: str,
    source_path: str,
    line_no: int,
) -> CanonicalEvent | RejectedEvent | None:
    """Parse one physical line. ``None`` means the line was blank."""
    if not isinstance(line, str) or not line.strip():
        return None
    try:
        record = json.loads(line.strip())
    except json.JSONDecodeError:
        return _reject("malformed_json", line, archive_hour, source_path, line_no)
    if not isinstance(record, dict):
        return _reject("not_object", line, archive_hour, source_path, line_no)

    event_id = _event_id(record.get("id"))
    if event_id is None:
        return _reject("missing_event_id", line, archive_hour, source_path, line_no)
    repo_id = extract_repos._repo_id(record.get("repo"))
    if repo_id is None:
        return _reject("missing_repo_id", line, archive_hour, source_path, line_no)
    event_type = record.get("type")
    if not isinstance(event_type, str) or not event_type:
        return _reject("missing_event_type", line, archive_hour, source_path, line_no)
    if "created_at" not in record or record.get("created_at") is None:
        return _reject("missing_event_time", line, archive_hour, source_path, line_no)
    created_at = record.get("created_at")
    if not isinstance(created_at, str):
        return _reject("bad_event_time", line, archive_hour, source_path, line_no)
    try:
        event_time = schemas.format_utc(schemas.parse_utc_iso(created_at))
    except (TypeError, ValueError):
        return _reject("bad_event_time", line, archive_hour, source_path, line_no)

    actor_id, actor_login = _actor(record.get("actor"))
    return CanonicalEvent(
        event_id=event_id,
        repo_id=repo_id,
        event_type=event_type,
        event_time=event_time,
        archive_hour=archive_hour,
        ingested_at=ingested_at,
        actor_id=actor_id,
        actor_login=actor_login,
        repo_name=_repo_name(record.get("repo")),
        payload_action=_payload_action(record.get("payload")),
        source_path=source_path,
    )


def _event_id(value: object) -> str | None:
    if isinstance(value, str):
        return value if value else None
    if type(value) is int:
        return str(value)
    return None


def _actor(actor: object) -> tuple[int | None, str | None]:
    if not isinstance(actor, dict):
        return None, None
    raw_id = actor.get("id")
    actor_id = raw_id if type(raw_id) is int else None
    login = actor.get("login")
    actor_login = login if isinstance(login, str) else None
    return actor_id, actor_login


def _repo_name(repo: object) -> str:
    if isinstance(repo, dict):
        name = repo.get("name")
        if isinstance(name, str):
            return name
    return ""


def _payload_action(payload: object) -> str | None:
    if isinstance(payload, dict):
        action = payload.get("action")
        if isinstance(action, str):
            return action
    return None


def _reject(
    reason: str,
    line: str,
    archive_hour: str,
    source_path: str,
    line_no: int,
) -> RejectedEvent:
    return RejectedEvent(reason, source_path, archive_hour, line_no, line[:_EXCERPT_CHARS])
