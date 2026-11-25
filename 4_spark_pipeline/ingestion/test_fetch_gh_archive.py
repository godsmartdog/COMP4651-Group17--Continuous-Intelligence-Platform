"""Tests for hourly GH Archive bronze ingestion."""

import base64
import gzip
import hashlib
import io
import ssl
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import fetch_gh_archive as gh


UTC = timezone.utc


def utc(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


def gzip_bytes(payload: bytes) -> bytes:
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="hour.json", mtime=0) as handle:
        handle.write(payload)
    return buffer.getvalue()


class FakeResponse:
    def __init__(self, status, headers=None, body=b""):
        self.status = status
        self.headers = {key.lower(): value for key, value in (headers or {}).items()}
        self.body = body
        self.closed = False

    def iter_chunks(self, size=1024 * 1024):
        view = self.body
        for offset in range(0, len(view), size):
            yield view[offset : offset + size]

    def close(self):
        self.closed = True


class ScriptedOpener:
    """Return queued responses. Each call is (url, method) -> FakeResponse."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def __call__(self, url, method):
        self.calls.append((url, method))
        if not self.script:
            raise AssertionError(f"unexpected {method} {url}")
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        status, headers, body = step
        return FakeResponse(status, headers, body)


class SslContext(unittest.TestCase):
    def test_uses_system_ca_bundle_when_python_has_none(self):
        missing = ssl.DefaultVerifyPaths(
            cafile=None,
            capath=None,
            openssl_cafile_env="SSL_CERT_FILE",
            openssl_cafile="/missing/cert.pem",
            openssl_capath_env="SSL_CERT_DIR",
            openssl_capath="/missing/certs",
        )
        calls = []

        def fake_create_default_context(cafile=None):
            calls.append(cafile)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = True
            context.verify_mode = ssl.CERT_REQUIRED
            return context

        def is_file(self):
            return self.as_posix() == "/etc/ssl/cert.pem"

        with (
            patch.object(gh.ssl, "get_default_verify_paths", return_value=missing),
            patch.object(gh.ssl, "create_default_context", side_effect=fake_create_default_context),
            patch.object(Path, "is_file", is_file),
        ):
            context = gh.ssl_context()

        self.assertEqual(calls, ["/etc/ssl/cert.pem"])
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)


class ArchiveNames(unittest.TestCase):
    def test_hour_is_not_zero_padded(self):
        self.assertEqual(gh.archive_name(utc(2024, 1, 1, 0)), "2024-01-01-0.json.gz")
        self.assertEqual(gh.archive_name(utc(2024, 1, 1, 15)), "2024-01-01-15.json.gz")

    def test_archive_url(self):
        self.assertEqual(
            gh.archive_url(utc(2024, 1, 1, 0)),
            "https://data.gharchive.org/2024-01-01-0.json.gz",
        )

    def test_bronze_path_is_hive_partitioned(self):
        path = gh.bronze_destination(Path("/bronze"), utc(2024, 1, 1, 3))
        self.assertEqual(
            path,
            Path("/bronze/year=2024/month=01/day=01/hour=03/2024-01-01-3.json.gz"),
        )


class WindowResolution(unittest.TestCase):
    def test_hours_lookback_excludes_the_current_partial_hour(self):
        start, end = gh.resolve_window(None, None, 6, utc(2024, 1, 2, 3, 40))
        self.assertEqual(start, utc(2024, 1, 1, 21))
        self.assertEqual(end, utc(2024, 1, 2, 3))
        self.assertEqual(len(gh.iter_hours(start, end)), 6)

    def test_date_only_start_fetches_that_utc_day(self):
        start, end = gh.resolve_window("2024-01-01", None, None, utc(2024, 1, 2))
        self.assertEqual((start, end), (utc(2024, 1, 1), utc(2024, 1, 2)))

    def test_datetime_start_without_end_fetches_one_hour(self):
        start, end = gh.resolve_window("2024-01-01T15:20:00Z", None, None, utc(2024, 1, 2))
        self.assertEqual((start, end), (utc(2024, 1, 1, 15), utc(2024, 1, 1, 16)))

    def test_date_end_is_exclusive(self):
        start, end = gh.resolve_window("2024-01-01", "2024-01-03", None, utc(2024, 1, 4))
        self.assertEqual(len(gh.iter_hours(start, end)), 48)

    def test_hours_cannot_be_combined_with_a_range(self):
        with self.assertRaises(ValueError):
            gh.resolve_window("2024-01-01", None, 6, utc(2024, 1, 2))

    def test_empty_range_is_rejected(self):
        with self.assertRaises(ValueError):
            gh.resolve_window("2024-01-02", "2024-01-01", None, utc(2024, 1, 3))


class FetchHour(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.hour = utc(2024, 1, 1, 0)
        self.payload = gzip_bytes(b'{"id":"1","type":"WatchEvent"}\n')
        self.md5 = hashlib.md5(self.payload).digest()
        self.headers = {
            "content-length": str(len(self.payload)),
            "x-goog-hash": "md5=" + base64.b64encode(self.md5).decode(),
        }

    def test_downloads_and_publishes_a_valid_gzip_atomically(self):
        opener = ScriptedOpener(
            [
                (200, self.headers, b""),
                (200, self.headers, self.payload),
            ]
        )
        result = gh.fetch_hour(self.hour, self.tmp, opener=opener, sleep=lambda _seconds: None)

        self.assertEqual(result.status, gh.FetchStatus.DOWNLOADED)
        self.assertTrue(result.path.is_file())
        self.assertEqual(result.path.read_bytes(), self.payload)
        self.assertEqual(list(result.path.parent.glob("*.partial")), [])
        self.assertEqual(opener.calls[0][1], "HEAD")
        self.assertEqual(opener.calls[1][1], "GET")
        self.assertTrue(opener.calls[0][0].endswith("/2024-01-01-0.json.gz"))

    def test_skips_when_local_gzip_matches_remote_length(self):
        dest = gh.bronze_destination(self.tmp, self.hour)
        dest.parent.mkdir(parents=True)
        dest.write_bytes(self.payload)
        opener = ScriptedOpener([(200, self.headers, b"")])

        result = gh.fetch_hour(self.hour, self.tmp, opener=opener, sleep=lambda _seconds: None)

        self.assertEqual(result.status, gh.FetchStatus.SKIPPED)
        self.assertEqual([method for _url, method in opener.calls], ["HEAD"])
        self.assertEqual(dest.read_bytes(), self.payload)

    def test_redownloads_when_local_size_does_not_match(self):
        dest = gh.bronze_destination(self.tmp, self.hour)
        dest.parent.mkdir(parents=True)
        dest.write_bytes(gzip_bytes(b'{"id":"stale"}\n'))
        opener = ScriptedOpener(
            [
                (200, self.headers, b""),
                (200, self.headers, self.payload),
            ]
        )

        result = gh.fetch_hour(self.hour, self.tmp, opener=opener, sleep=lambda _seconds: None)

        self.assertEqual(result.status, gh.FetchStatus.DOWNLOADED)
        self.assertEqual(dest.read_bytes(), self.payload)

    def test_missing_hour_does_not_create_a_file(self):
        opener = ScriptedOpener([(404, {}, b"")])
        result = gh.fetch_hour(self.hour, self.tmp, opener=opener, sleep=lambda _seconds: None)

        self.assertEqual(result.status, gh.FetchStatus.MISSING)
        self.assertFalse(gh.bronze_destination(self.tmp, self.hour).exists())
        self.assertEqual([method for _url, method in opener.calls], ["HEAD"])

    def test_retries_transient_failures_then_publishes(self):
        opener = ScriptedOpener(
            [
                (503, {}, b""),
                (200, self.headers, b""),
                (200, {"content-length": "3"}, b"bad"),
                (200, self.headers, b""),
                (200, self.headers, self.payload),
            ]
        )
        sleeps = []
        result = gh.fetch_hour(
            self.hour,
            self.tmp,
            opener=opener,
            retries=4,
            sleep=sleeps.append,
        )

        self.assertEqual(result.status, gh.FetchStatus.DOWNLOADED)
        self.assertEqual(result.path.read_bytes(), self.payload)
        self.assertGreaterEqual(len(sleeps), 2)
        self.assertFalse(Path(str(result.path) + ".partial").exists())

    def test_md5_mismatch_is_not_published(self):
        bad = gzip_bytes(b'{"id":"other"}\n')
        headers = dict(self.headers)
        headers["content-length"] = str(len(bad))
        opener = ScriptedOpener(
            [
                (200, self.headers, b""),
                (200, headers, bad),
            ]
        )
        result = gh.fetch_hour(
            self.hour,
            self.tmp,
            opener=opener,
            retries=1,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(result.status, gh.FetchStatus.FAILED)
        self.assertFalse(gh.bronze_destination(self.tmp, self.hour).exists())

    def test_range_keeps_hour_order_and_counts(self):
        def opener(url, method):
            name = url.rsplit("/", 1)[-1]
            if method == "HEAD":
                return FakeResponse(404 if name.startswith("2024-01-01-1") else 200, self.headers, b"")
            return FakeResponse(200, self.headers, self.payload)

        results = gh.fetch_range(
            utc(2024, 1, 1, 0),
            utc(2024, 1, 1, 2),
            self.tmp,
            opener=opener,
            workers=2,
            sleep=lambda _seconds: None,
        )

        self.assertEqual([item.hour.hour for item in results], [0, 1])
        self.assertEqual(results[0].status, gh.FetchStatus.DOWNLOADED)
        self.assertEqual(results[1].status, gh.FetchStatus.MISSING)
        summary = gh.summarize(results)
        self.assertEqual(summary["downloaded"], 1)
        self.assertEqual(summary["missing"], 1)
        self.assertEqual(summary["failed"], 0)


if __name__ == "__main__":
    unittest.main()
