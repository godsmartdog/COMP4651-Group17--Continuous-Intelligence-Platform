"""Tests for GH Archive repository extraction and canonical schemas."""

import gzip
import io
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import extract_repos as extract
import schemas


UTC = timezone.utc


def utc(year, month, day, hour=0, minute=0, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=UTC)


def gzip_bytes(payload: bytes) -> bytes:
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="hour.json", mtime=0) as handle:
        handle.write(payload)
    return buffer.getvalue()


def event(repo_id, name):
    return json.dumps({"repo": {"id": repo_id, "name": name}}, separators=(",", ":"))


class Schemas(unittest.TestCase):
    def test_utc_timestamps_round_trip_without_fractions(self):
        stamp = utc(2024, 1, 1, 3, 4, 5)
        self.assertEqual(schemas.format_utc(stamp), "2024-01-01T03:04:05Z")
        self.assertEqual(schemas.parse_utc_iso("2024-01-01T03:04:05Z"), stamp)

    def test_manifest_json_round_trip(self):
        manifest = schemas.IngestionManifest(
            manifest_version=schemas.MANIFEST_VERSION,
            archive_hour="2024-01-01T00:00:00Z",
            source_url="https://data.gharchive.org/2024-01-01-0.json.gz",
            bronze_path="year=2024/month=01/day=01/hour=00/2024-01-01-0.json.gz",
            size_bytes=12,
            sha256="abc",
            fetch_status="downloaded",
            event_count=2,
            malformed_count=1,
            missing_repo_count=1,
            repo_count=1,
            ingested_at="2024-01-01T01:00:00Z",
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            schemas.write_manifest(path, manifest)
            self.assertFalse(path.with_name("manifest.json.partial").exists())
            self.assertEqual(schemas.read_manifest(path), manifest)


class ExtractRepos(unittest.TestCase):
    def test_counts_unique_repositories_and_skips_invalid_lines(self):
        lines = "\n".join(
            [
                event(10, "a/b"),
                event(10, "a/b"),
                event(2, "z/y"),
                json.dumps({"type": "WatchEvent"}),
                json.dumps({"repo": {"name": "no-id/repo"}}),
                json.dumps({"repo": {"id": None, "name": "x/y"}}),
                json.dumps({"repo": {"id": True, "name": "t/t"}}),
                "NOT JSON",
                "",
                json.dumps({"repo": {"id": "15", "name": "c/d"}}),
            ]
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hour.json.gz"
            path.write_bytes(gzip_bytes(lines.encode("utf-8")))
            result = extract.extract_repos(path, api_base="https://api.github.com")

        self.assertEqual(result.event_count, 8)
        self.assertEqual(result.malformed_count, 1)
        self.assertEqual(result.missing_repo_count, 4)
        self.assertEqual(
            [(repo.repo_id, repo.full_name, repo.event_count) for repo in result.repos],
            [(2, "z/y", 1), (10, "a/b", 2), (15, "c/d", 1)],
        )
        self.assertEqual(
            result.repos[0].api_url,
            "https://api.github.com/repositories/2",
        )

    def test_repos_jsonl_is_deterministic(self):
        observed = (
            schemas.ObservedRepo(10, "a/b", "https://api.github.com/repositories/10", 2),
            schemas.ObservedRepo(2, "z/y", "https://api.github.com/repositories/2", 1),
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "repos.jsonl"
            extract.write_repos(path, observed)
            first = path.read_bytes()
            extract.write_repos(path, observed)
            second = path.read_bytes()
            loaded = extract.read_repos(path)

        self.assertEqual(first, second)
        self.assertTrue(first.endswith(b"\n"))
        self.assertEqual([repo.repo_id for repo in loaded], [2, 10])
        self.assertEqual(list(path.parent.glob("*.partial")), [])

    def test_empty_archive_has_no_repositories(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hour.json.gz"
            path.write_bytes(gzip_bytes(b""))
            result = extract.extract_repos(path)

        self.assertEqual(result.event_count, 0)
        self.assertEqual(result.malformed_count, 0)
        self.assertEqual(result.missing_repo_count, 0)
        self.assertEqual(result.repos, ())

    def test_non_gzip_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hour.json.gz"
            path.write_bytes(b"not gzip")
            with self.assertRaises(ValueError):
                extract.extract_repos(path)


if __name__ == "__main__":
    unittest.main()
