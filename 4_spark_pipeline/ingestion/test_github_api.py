"""Tests for the GitHub REST enrichment queue, cache, and retry budget."""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import github_api
import schemas


UTC = timezone.utc


def utc(year, month, day, hour=0, minute=0, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=UTC)


def repo(repo_id=1, name="octocat/hello", events=1):
    return schemas.ObservedRepo(
        repo_id,
        name,
        f"https://api.github.com/repositories/{repo_id}",
        events,
    )


def repo_body(repo_id=1, name="octocat/hello"):
    return json.dumps(
        {
            "id": repo_id,
            "full_name": name,
            "html_url": f"https://github.com/{name}",
            "description": "demo",
            "topics": ["spark", "github"],
            "language": "Python",
            "created_at": "2020-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z",
            "visibility": "public",
            "archived": False,
            "stargazers_count": 3,
            "forks_count": 1,
        },
        separators=(",", ":"),
    ).encode("utf-8")


class ScriptedApi:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def __call__(self, url, method, headers):
        self.calls.append((url, method, dict(headers)))
        if not self.script:
            raise AssertionError(f"unexpected {method} {url}")
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        status, headers, body = step
        return github_api.ApiResponse(status, headers, body)


class EnrichmentQueue(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = github_api.EnrichmentStore(self.tmp / "github.sqlite")
        self.now = utc(2024, 1, 1, 0, 0, 0)
        self.refresh = timedelta(hours=24)
        self.retry = timedelta(hours=1)

    def tearDown(self):
        self.store.close()

    def enqueue(self, repos, now=None, refresh_after=None, retry_after=None):
        return self.store.enqueue(
            repos,
            now=self.now if now is None else now,
            refresh_after=self.refresh if refresh_after is None else refresh_after,
            retry_after=self.retry if retry_after is None else retry_after,
        )

    def test_enqueue_is_idempotent_for_pending_repositories(self):
        first = self.enqueue([repo(), repo(2, "a/b")])
        second = self.enqueue([repo(), repo(2, "a/b")])

        self.assertEqual(first.enqueued, 2)
        self.assertEqual(second.already_queued, 2)
        self.assertEqual(self.store.queue_counts(), {"pending": 2})
        item = self.store.queue_item(1)
        self.assertEqual(item.status, "pending")
        self.assertEqual(item.reason, "missing")
        self.assertEqual(item.attempts, 0)
        self.assertFalse(item.permanent)
        self.assertEqual(item.api_url, "https://api.github.com/repositories/1")
        self.assertEqual(item.enqueued_at, "2024-01-01T00:00:00Z")
        self.assertEqual(
            [row.repo_id for row in self.store.due_items(self.now, 10)],
            [1, 2],
        )

    def test_fresh_cache_is_not_queued_until_the_refresh_window(self):
        body = repo_body()
        opener = ScriptedApi([(200, {"etag": '"v1"'}, body)])
        self.enqueue([repo()])
        github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_requests=5,
            sleep=lambda _seconds: None,
        )

        fresh = self.enqueue([repo()])
        stale = self.enqueue([repo()], now=self.now + timedelta(hours=24))

        self.assertEqual(fresh.fresh, 1)
        self.assertEqual(stale.enqueued, 1)
        self.assertEqual(self.store.queue_item(1).status, "pending")
        self.assertEqual(self.store.queue_item(1).reason, "refresh")
        self.assertEqual(self.store.queue_item(1).attempts, 0)

    def test_permanent_failure_is_not_enqueued_again(self):
        opener = ScriptedApi([(404, {}, b'{"message":"Not Found"}')])
        self.enqueue([repo()])
        github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_attempts=3,
            sleep=lambda _seconds: None,
        )

        again = self.enqueue([repo()], now=self.now + timedelta(days=2))

        self.assertEqual(again.skipped_permanent, 1)
        self.assertEqual(len(opener.calls), 1)
        item = self.store.queue_item(1)
        self.assertEqual(item.status, "failed")
        self.assertTrue(item.permanent)
        self.assertEqual(self.store.list_failures(), [item])

    def test_exhausted_transient_failure_waits_before_requeue(self):
        opener = ScriptedApi([(503, {}, b""), (503, {}, b""), (503, {}, b"")])
        sleeps = []
        self.enqueue([repo()])
        summary = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_attempts=3,
            sleep=sleeps.append,
        )

        self.assertEqual(summary.failed, 1)
        self.assertEqual(summary.requests, 3)
        self.assertEqual(sleeps, [1, 2])
        self.assertFalse(self.store.queue_item(1).permanent)
        waiting = self.enqueue([repo()])
        self.assertEqual(waiting.waiting_retry, 1)
        self.assertEqual(self.store.queue_item(1).status, "failed")

        later = self.enqueue([repo()], now=self.now + timedelta(hours=1))
        self.assertEqual(later.enqueued, 1)
        self.assertEqual(self.store.queue_item(1).status, "pending")
        self.assertEqual(self.store.queue_item(1).attempts, 0)


class DrainApi(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = github_api.EnrichmentStore(self.tmp / "github.sqlite")
        self.now = utc(2024, 1, 2, 3, 4, 5)
        self.store.enqueue(
            [repo()],
            now=self.now,
            refresh_after=timedelta(hours=24),
            retry_after=timedelta(hours=1),
        )

    def enqueue_second(self):
        self.store.enqueue(
            [repo(2, "a/b")],
            now=self.now,
            refresh_after=timedelta(hours=24),
            retry_after=timedelta(hours=1),
        )

    def tearDown(self):
        self.store.close()

    def test_success_stores_raw_json_cache_and_rate_budget(self):
        self.enqueue_second()
        body = repo_body()
        reset_epoch = int((self.now + timedelta(minutes=30)).timestamp())
        reset = datetime.fromtimestamp(reset_epoch, tz=UTC)
        opener = ScriptedApi(
            [
                (
                    200,
                    {
                        "etag": '"v1"',
                        "x-ratelimit-remaining": "42",
                        "x-ratelimit-reset": str(reset_epoch),
                    },
                    body,
                )
            ]
        )
        summary = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            token="secret",
            max_requests=1,
            min_remaining=5,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(summary.succeeded, 1)
        self.assertEqual(summary.requests, 1)
        self.assertEqual(summary.stopped_reason, "max_requests")
        url, method, headers = opener.calls[0]
        self.assertEqual(method, "GET")
        self.assertEqual(url, "https://api.github.com/repositories/1")
        self.assertEqual(headers["Accept"], "application/vnd.github+json")
        self.assertEqual(headers["X-GitHub-Api-Version"], "2022-11-28")
        self.assertEqual(headers["Authorization"], "Bearer secret")
        self.assertNotIn("If-None-Match", headers)
        self.assertNotIn("secret", list(self.tmp.joinpath("api").rglob("response.json"))[0].read_text())

        cache = self.store.cache_entry(1)
        self.assertEqual(cache.etag, '"v1"')
        self.assertEqual(cache.fetched_at, "2024-01-02T03:04:05Z")
        self.assertEqual(cache.http_status, 200)
        self.assertFalse(cache.incomplete)
        self.assertEqual(cache.description, "demo")
        self.assertEqual(cache.topics, ("spark", "github"))
        self.assertEqual(cache.language, "Python")
        self.assertEqual(cache.visibility, "public")
        self.assertFalse(cache.archived)
        self.assertEqual(cache.stargazers_count, 3)
        self.assertEqual(Path(cache.snapshot_path).read_bytes(), body)
        self.assertEqual(self.store.queue_item(1).status, "succeeded")
        self.assertEqual(self.store.queue_item(1).attempts, 1)
        self.assertEqual(self.store.queue_item(2).status, "pending")
        self.assertEqual(self.store.budget().remaining, 42)
        self.assertEqual(self.store.budget().reset_at, schemas.format_utc(reset))
        self.assertEqual(list(self.tmp.rglob("*.partial")), [])

    def test_not_modified_reuses_the_cached_snapshot(self):
        body = repo_body()
        first = ScriptedApi([(200, {"etag": '"v1"', "x-ratelimit-remaining": "40"}, body)])
        github_api.drain(
            self.store,
            opener=first,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_requests=1,
            sleep=lambda _seconds: None,
        )
        self.store.enqueue(
            [repo()],
            now=self.now + timedelta(hours=25),
            refresh_after=timedelta(hours=24),
            retry_after=timedelta(hours=1),
        )
        second = ScriptedApi([(304, {"etag": '"v1"', "x-ratelimit-remaining": "40"}, b"")])
        summary = github_api.drain(
            self.store,
            opener=second,
            bronze_dir=self.tmp / "api",
            now=self.now + timedelta(hours=25),
            max_requests=5,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(summary.not_modified, 1)
        self.assertEqual(second.calls[0][2]["If-None-Match"], '"v1"')
        self.assertEqual(len(list(self.tmp.joinpath("api").rglob("response.json"))), 1)
        cache = self.store.cache_entry(1)
        self.assertEqual(cache.http_status, 304)
        self.assertEqual(cache.fetched_at, "2024-01-03T04:04:05Z")
        self.assertEqual(cache.description, "demo")
        self.assertEqual(Path(cache.snapshot_path).read_bytes(), body)

    def test_not_found_is_permanent_and_keeps_the_error_body(self):
        body = b'{"message":"Not Found"}'
        opener = ScriptedApi([(404, {}, body)])
        summary = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_requests=5,
            max_attempts=3,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(summary.failed, 1)
        self.assertEqual(len(opener.calls), 1)
        cache = self.store.cache_entry(1)
        self.assertTrue(cache.incomplete)
        self.assertEqual(cache.http_status, 404)
        self.assertIsNone(cache.description)
        self.assertEqual(Path(cache.snapshot_path).read_bytes(), body)
        self.assertIn("404", self.store.queue_item(1).last_error)
        self.assertEqual(self.store.queue_item(1).last_status_code, 404)

    def test_timeout_then_success_retries_with_backoff(self):
        body = repo_body()
        opener = ScriptedApi([TimeoutError("timed out"), (200, {"etag": '"v1"'}, body)])
        sleeps = []
        summary = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_requests=5,
            max_attempts=3,
            sleep=sleeps.append,
        )

        self.assertEqual(summary.succeeded, 1)
        self.assertEqual(summary.requests, 1)
        self.assertEqual(sleeps, [1])
        self.assertEqual(self.store.queue_item(1).attempts, 2)
        self.assertEqual(self.store.queue_item(1).status, "succeeded")

    def test_rate_limit_defers_without_burning_attempts(self):
        self.enqueue_second()
        reset_epoch = int((self.now + timedelta(hours=1)).timestamp())
        reset = datetime.fromtimestamp(reset_epoch, tz=UTC)
        opener = ScriptedApi(
            [
                (
                    429,
                    {
                        "retry-after": "30",
                        "x-ratelimit-remaining": "0",
                        "x-ratelimit-reset": str(reset_epoch),
                    },
                    b'{"message":"rate limit exceeded"}',
                )
            ]
        )
        summary = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_requests=10,
            sleep=lambda _seconds: None,
        )
        again = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_requests=10,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(summary.stopped_reason, "rate_limit")
        self.assertEqual(summary.deferred, 1)
        self.assertEqual(summary.requests, 1)
        self.assertEqual(again.requests, 0)
        self.assertEqual(again.stopped_reason, "rate_limit")
        self.assertEqual(len(opener.calls), 1)
        item = self.store.queue_item(1)
        self.assertEqual(item.status, "deferred")
        self.assertEqual(item.attempts, 0)
        self.assertFalse(item.permanent)
        self.assertEqual(item.next_attempt_at, schemas.format_utc(reset))
        self.assertEqual(self.store.queue_item(2).status, "pending")

    def test_forbidden_without_rate_limit_headers_is_permanent(self):
        opener = ScriptedApi([(403, {}, b'{"message":"Resource not accessible by integration"}')])
        summary = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_requests=5,
            max_attempts=3,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(summary.failed, 1)
        self.assertEqual(len(opener.calls), 1)
        self.assertTrue(self.store.queue_item(1).permanent)
        self.assertEqual(self.store.queue_counts()["failed"], 1)

    def test_low_remaining_stops_before_the_next_repository(self):
        self.enqueue_second()
        opener = ScriptedApi(
            [
                (200, {"etag": '"v1"', "x-ratelimit-remaining": "5"}, repo_body()),
                (200, {"etag": '"v2"', "x-ratelimit-remaining": "4"}, repo_body(2, "a/b")),
            ]
        )
        summary = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_requests=10,
            min_remaining=5,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(summary.succeeded, 1)
        self.assertEqual(summary.stopped_reason, "min_remaining")
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(self.store.queue_item(2).status, "pending")

    def test_expired_rate_window_allows_another_request(self):
        self.enqueue_second()
        reset_epoch = int((self.now + timedelta(minutes=30)).timestamp())
        reset = datetime.fromtimestamp(reset_epoch, tz=UTC)
        opener = ScriptedApi(
            [
                (
                    200,
                    {
                        "etag": '"v1"',
                        "x-ratelimit-remaining": "0",
                        "x-ratelimit-reset": str(reset_epoch),
                    },
                    repo_body(),
                ),
                (200, {"etag": '"v2"', "x-ratelimit-remaining": "4999"}, repo_body(2, "a/b")),
            ]
        )
        blocked = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=self.now,
            max_requests=10,
            min_remaining=0,
            sleep=lambda _seconds: None,
        )
        resumed = github_api.drain(
            self.store,
            opener=opener,
            bronze_dir=self.tmp / "api",
            now=reset + timedelta(seconds=1),
            max_requests=10,
            min_remaining=0,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(blocked.stopped_reason, "rate_limit")
        self.assertEqual(resumed.succeeded, 1)
        self.assertEqual(resumed.requests, 1)
        self.assertEqual(self.store.queue_item(2).status, "succeeded")
        self.assertEqual(opener.calls[1][0], "https://api.github.com/repositories/2")


if __name__ == "__main__":
    unittest.main()
