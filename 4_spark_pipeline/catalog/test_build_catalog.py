"""Spark catalog tests. Expected counts come from the fixtures below."""

import gzip
import hashlib
import io
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import catalog.build_catalog as job
import fetch_gh_archive as gh
import schemas


UTC = timezone.utc


def _gzip_file(path: Path, lines: list[str]) -> str:
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="", mtime=0) as handle:
        handle.write(payload)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buffer.getvalue())
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _event(event_id, repo_id, event_type, created_at, repo_name):
    return json.dumps(
        {
            "id": event_id,
            "type": event_type,
            "actor": {"id": 7, "login": "octocat"},
            "repo": {"id": repo_id, "name": repo_name},
            "payload": {"action": "opened"},
            "created_at": created_at,
        },
        separators=(",", ":"),
    )


def _write_hour(bronze: Path, hour: datetime, ingested_at: str, lines: list[str]) -> None:
    archive = gh.bronze_destination(bronze / "gharchive", hour)
    digest = _gzip_file(archive, lines)
    manifest = schemas.IngestionManifest(
        manifest_version=schemas.MANIFEST_VERSION,
        archive_hour=schemas.format_utc(hour),
        source_url="https://data.gharchive.org/test.json.gz",
        bronze_path="data\\bronze\\does-not-exist.json.gz",
        size_bytes=archive.stat().st_size,
        sha256=digest,
        fetch_status="downloaded",
        event_count=0,
        malformed_count=0,
        missing_repo_count=0,
        repo_count=0,
        ingested_at=ingested_at,
    )
    schemas.write_manifest(archive.parent / "manifest.json", manifest)


def _write_response(bronze: Path, repo_id: int, fetched_at: str, body: dict) -> None:
    path = bronze / "github_api" / f"repo_id={repo_id}" / f"fetched_at={fetched_at}" / "response.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(body).encode("utf-8"))


def _signature(directory: Path):
    files = []
    for path in sorted(item for item in directory.rglob("*") if item.is_file()):
        stat = path.stat()
        files.append((path.relative_to(directory).as_posix(), stat.st_mtime_ns, stat.st_size))
    return tuple(files)


def _rows_by_repo(frame):
    return {int(row["repo_id"]): row.asDict(recursive=True) for row in frame.collect()}


class BuildCatalog(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self._tmp.name)
        self.bronze = self.root / "bronze"
        self.lake = self.root / "lake"

    def tearDown(self):
        job._stop_spark()
        self._tmp.cleanup()

    def test_dedup_quarantine_and_idempotent_publish(self):
        _write_hour(
            self.bronze,
            datetime(2024, 1, 1, tzinfo=UTC),
            "2024-01-05T00:00:00Z",
            [
                _event("shared", 10, "WatchEvent", "2024-01-03T00:00:00Z", "old/name"),
                "",
                "not-json",
            ],
        )
        _write_hour(
            self.bronze,
            datetime(2024, 1, 3, tzinfo=UTC),
            "2024-01-03T01:00:00Z",
            [
                _event("shared", 10, "WatchEvent", "2024-01-03T00:00:00Z", "new/name"),
                _event("unique", 11, "ForkEvent", "2024-01-01T00:30:00Z", "octocat/forked"),
            ],
        )

        snapshot = job.build_catalog(self.bronze, self.lake)
        current = self.lake / "gold" / "catalog" / "CURRENT"
        silver_dir = self.lake / "silver" / "events" / f"snapshot_id={snapshot}"
        gold_dir = self.lake / "gold" / "catalog" / f"snapshot_id={snapshot}"
        self.assertEqual(current.read_text(encoding="utf-8"), snapshot + "\n")
        quality = json.loads((gold_dir / "quality.json").read_text(encoding="utf-8"))
        self.assertEqual(quality["silver_rows"], 2)
        self.assertEqual(quality["gold_rows"], 2)
        self.assertEqual(quality["quarantine_rows"], 1)
        self.assertTrue(all(quality["checks"].values()))

        spark = job.spark_session()
        silver = spark.read.parquet(str(silver_dir))
        gold = _rows_by_repo(spark.read.parquet(str(gold_dir / "repositories")))
        quarantine = spark.read.parquet(
            str(self.lake / "silver" / "quarantine" / f"snapshot_id={snapshot}")
        ).collect()
        self.assertEqual(silver.count(), 2)
        self.assertEqual(len(quarantine), 1)
        self.assertEqual(quarantine[0]["reason"], "malformed_json")
        self.assertEqual(quarantine[0]["excerpt"], "not-json")
        self.assertEqual(quarantine[0]["line_no"], 3)
        self.assertEqual(gold[10]["full_name"], "new/name")
        self.assertEqual(gold[10]["enrichment_status"], "incomplete")
        self.assertEqual(gold[10]["watch_count"], 1)
        self.assertEqual(gold[10]["window_24h_watch_count"], 1)
        self.assertEqual(gold[10]["window_7d_watch_count"], 1)
        self.assertEqual(gold[10]["as_of"], "2024-01-03T00:00:00Z")
        self.assertEqual(gold[11]["full_name"], "octocat/forked")
        self.assertEqual(gold[11]["fork_count"], 1)
        self.assertEqual(gold[11]["window_24h_fork_count"], 0)
        self.assertEqual(gold[11]["window_7d_fork_count"], 1)
        self.assertEqual(gold[11]["watch_count"], 0)
        job._stop_spark()

        before = _signature(self.lake / "silver")
        again = job.build_catalog(self.bronze, self.lake)
        self.assertEqual(again, snapshot)
        self.assertEqual(current.read_text(encoding="utf-8"), snapshot + "\n")
        self.assertEqual(_signature(self.lake / "silver"), before)
        spark = job.spark_session()
        self.assertEqual(spark.read.parquet(str(silver_dir)).count(), 2)

    def test_enrichment_status_follows_usable_snapshots(self):
        _write_hour(
            self.bronze,
            datetime(2024, 2, 1, tzinfo=UTC),
            "2024-02-01T02:00:00Z",
            [
                _event("pr", 7, "PullRequestEvent", "2024-02-01T00:00:00Z", "event/name"),
                _event("issue", 8, "IssuesEvent", "2024-02-01T00:10:00Z", "acme/bare"),
            ],
        )
        _write_response(
            self.bronze,
            7,
            "20240201T000000Z",
            {
                "id": 7,
                "full_name": "acme/old",
                "description": "old description",
                "stargazers_count": 1,
            },
        )
        _write_response(
            self.bronze,
            7,
            "20240202T000000Z",
            {
                "id": 7,
                "full_name": "acme/lib",
                "description": "Widgets for tests",
                "topics": ["widgets"],
                "language": "Python",
                "html_url": "https://github.com/acme/lib",
                "created_at": "2020-01-01T00:00:00Z",
                "updated_at": "2024-02-01T00:00:00Z",
                "visibility": "public",
                "archived": False,
                "stargazers_count": 12,
                "forks_count": 3,
                "private": False,
            },
        )
        _write_response(self.bronze, 8, "20240201T000000Z", {"id": 999, "message": "Not Found"})
        _write_response(
            self.bronze,
            99,
            "20240201T000000Z",
            {"id": 99, "full_name": "only/api", "description": "no events", "stargazers_count": 4},
        )

        snapshot = job.build_catalog(self.bronze, self.lake)
        spark = job.spark_session()
        gold = _rows_by_repo(
            spark.read.parquet(
                str(self.lake / "gold" / "catalog" / f"snapshot_id={snapshot}" / "repositories")
            )
        )
        self.assertEqual(set(gold), {7, 8})
        complete = gold[7]
        self.assertEqual(complete["enrichment_status"], "complete")
        self.assertEqual(complete["description"], "Widgets for tests")
        self.assertEqual(complete["full_name"], "acme/lib")
        self.assertEqual(complete["api_stargazers_count"], 12)
        self.assertEqual(complete["watch_count"], 0)
        self.assertNotEqual(complete["api_stargazers_count"], complete["watch_count"])
        incomplete = gold[8]
        self.assertEqual(incomplete["enrichment_status"], "incomplete")
        self.assertEqual(incomplete["full_name"], "acme/bare")
        self.assertIsNone(incomplete["description"])

    def test_publish_current_false_check_leaves_current_unchanged(self):
        current = self.lake / "gold" / "catalog" / "CURRENT"
        schemas.atomic_write(current, b"already-published\n")
        published = job.publish_current(
            self.lake,
            "new-snapshot",
            {
                "unique_events": True,
                "unique_repos": True,
                "event_counts_match": True,
                "typed_counts_match": False,
                "window_counts_match": True,
            },
        )
        self.assertFalse(published)
        self.assertEqual(current.read_bytes(), b"already-published\n")


if __name__ == "__main__":
    unittest.main()
