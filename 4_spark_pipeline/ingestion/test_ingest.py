"""Tests for the Phase 1 hourly ingestion workflow."""

import gzip
import hashlib
import io
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import fetch_gh_archive as gh
import github_api
import ingest
import schemas


UTC = timezone.utc


def utc(year, month, day, hour=0, minute=0, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=UTC)


def gzip_bytes(payload: bytes) -> bytes:
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="hour.json", mtime=0) as handle:
        handle.write(payload)
    return buffer.getvalue()


def archive_payload() -> bytes:
    lines = "\n".join(
        [
            json.dumps({"id": "1", "repo": {"id": 10, "name": "a/b"}}),
            json.dumps({"id": "2", "repo": {"id": 10, "name": "a/b"}}),
            json.dumps({"id": "3", "type": "WatchEvent"}),
            "NOT JSON",
        ]
    )
    return gzip_bytes((lines + "\n").encode("utf-8"))


class ArchiveOpener:
    def __init__(self, payload):
        self.payload = payload
        self.headers = {"content-length": str(len(payload))}
        self.calls = []

    def __call__(self, url, method):
        self.calls.append((url, method))
        if method == "HEAD":
            return gh.HttpResponse(200, self.headers, b"")
        return gh.HttpResponse(200, self.headers, self.payload)


class IngestWindow(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.bronze = self.tmp / "gharchive"
        self.api = self.tmp / "api"
        self.store = github_api.EnrichmentStore(self.tmp / "github.sqlite")
        self.now = utc(2024, 1, 2, 4)
        self.payload = archive_payload()

    def tearDown(self):
        self.store.close()

    def test_hour_writes_manifest_repos_and_one_queue_row(self):
        opener = ArchiveOpener(self.payload)
        report = ingest.ingest_window(
            utc(2024, 1, 1, 0),
            utc(2024, 1, 1, 2),
            self.bronze,
            store=self.store,
            opener=opener,
            api_bronze=self.api,
            now=self.now,
            refresh_after=timedelta(hours=24),
            retry_after=timedelta(hours=1),
            workers=1,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(report.enqueue.enqueued, 1)
        self.assertEqual(report.enqueue.already_queued, 1)
        self.assertIsNone(report.enrichment)
        self.assertEqual([hour.result.status for hour in report.hours], [gh.FetchStatus.DOWNLOADED, gh.FetchStatus.DOWNLOADED])
        manifest = report.hours[0].manifest
        self.assertEqual(manifest.fetch_status, "downloaded")
        self.assertEqual(manifest.sha256, hashlib.sha256(self.payload).hexdigest())
        self.assertEqual(manifest.size_bytes, len(self.payload))
        self.assertEqual(manifest.event_count, 3)
        self.assertEqual(manifest.malformed_count, 1)
        self.assertEqual(manifest.missing_repo_count, 1)
        self.assertEqual(manifest.repo_count, 1)
        self.assertEqual(manifest.ingested_at, "2024-01-02T04:00:00Z")
        self.assertEqual(manifest.source_url, "https://data.gharchive.org/2024-01-01-0.json.gz")
        self.assertEqual(schemas.read_manifest(report.hours[0].manifest_path), manifest)
        repos = report.hours[0].repos_path.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(json.loads(repos[0])["repo_id"], 10)
        self.assertEqual(json.loads(repos[0])["event_count"], 2)
        self.assertEqual(self.store.queue_item(10).reason, "missing")
        self.assertEqual(list(self.bronze.rglob("*.partial")), [])

        second = ingest.ingest_window(
            utc(2024, 1, 1, 0),
            utc(2024, 1, 1, 2),
            self.bronze,
            store=self.store,
            opener=opener,
            api_bronze=self.api,
            now=self.now + timedelta(minutes=5),
            refresh_after=timedelta(hours=24),
            retry_after=timedelta(hours=1),
            workers=1,
            sleep=lambda _seconds: None,
        )

        self.assertEqual([hour.result.status for hour in second.hours], [gh.FetchStatus.SKIPPED, gh.FetchStatus.SKIPPED])
        self.assertEqual(second.enqueue.enqueued, 0)
        self.assertEqual(second.enqueue.already_queued, 2)
        self.assertEqual(self.store.queue_counts(), {"pending": 1})
        self.assertEqual(second.hours[0].manifest.sha256, manifest.sha256)
        self.assertEqual([method for _url, method in opener.calls if method == "GET"], ["GET", "GET"])

    def test_missing_and_failed_hours_record_manifests_without_repos(self):
        def opener(url, method):
            if "2024-01-01-0.json.gz" in url:
                return gh.HttpResponse(404, {}, b"")
            raise OSError("boom")

        report = ingest.ingest_window(
            utc(2024, 1, 1, 0),
            utc(2024, 1, 1, 2),
            self.bronze,
            store=self.store,
            opener=opener,
            api_bronze=self.api,
            now=self.now,
            refresh_after=timedelta(hours=24),
            retry_after=timedelta(hours=1),
            retries=1,
            workers=1,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(report.hours[0].manifest.fetch_status, "missing")
        self.assertEqual(report.hours[1].manifest.fetch_status, "failed")
        self.assertIsNone(report.hours[0].repos_path)
        self.assertIsNone(report.hours[1].repos_path)
        self.assertEqual(report.hours[0].manifest.sha256, "")
        self.assertEqual(report.hours[0].manifest.repo_count, 0)
        self.assertEqual(report.enqueue.enqueued, 0)
        self.assertIsNone(self.store.queue_item(10))
        missing_gzip = gh.bronze_destination(self.bronze, utc(2024, 1, 1, 0))
        failed_gzip = gh.bronze_destination(self.bronze, utc(2024, 1, 1, 1))
        self.assertFalse(missing_gzip.exists())
        self.assertFalse(failed_gzip.exists())
        self.assertTrue(report.hours[0].manifest_path.is_file())
        self.assertTrue(report.hours[1].manifest_path.is_file())

    def test_main_rejects_an_empty_window(self):
        self.assertEqual(ingest.main(["--hours", "0"]), 2)


if __name__ == "__main__":
    unittest.main()
