"""Parser tests. These do not start Spark."""

import json
import unittest

from catalog.parse import CanonicalEvent, RejectedEvent, parse_line


def _parse(line, line_no=1):
    return parse_line(
        line,
        archive_hour="2026-11-25T16:00:00Z",
        ingested_at="2026-11-25T17:30:59Z",
        source_path="year=2026/month=11/day=25/hour=16/2026-11-25-16.json.gz",
        line_no=line_no,
    )


class ParseLine(unittest.TestCase):
    def test_pull_request_event_returns_normalized_fields(self):
        line = json.dumps(
            {
                "id": "21280009525",
                "type": "PullRequestEvent",
                "actor": {
                    "id": 289182770,
                    "login": "brunomauneau-dev",
                    "display_login": "brunomauneau-dev",
                },
                "repo": {
                    "id": 1267107778,
                    "name": "brunomauneau-dev/caes-widget",
                    "url": "https://api.github.com/repos/brunomauneau-dev/caes-widget",
                },
                "payload": {"action": "opened", "number": 7, "pull_request": {"id": 1}},
                "public": True,
                "created_at": "2026-11-25T16:00:00.500Z",
            },
            separators=(",", ":"),
        )
        parsed = _parse(line)
        self.assertEqual(
            parsed,
            CanonicalEvent(
                event_id="21280009525",
                repo_id=1267107778,
                event_type="PullRequestEvent",
                event_time="2026-11-25T16:00:00Z",
                archive_hour="2026-11-25T16:00:00Z",
                ingested_at="2026-11-25T17:30:59Z",
                actor_id=289182770,
                actor_login="brunomauneau-dev",
                repo_name="brunomauneau-dev/caes-widget",
                payload_action="opened",
                source_path="year=2026/month=11/day=25/hour=16/2026-11-25-16.json.gz",
            ),
        )

    def test_int_event_id_and_digit_repo_id_are_normalized(self):
        line = json.dumps(
            {
                "id": 99,
                "type": "WatchEvent",
                "repo": {"id": "15", "name": "a/b"},
                "created_at": "2024-01-01T08:30:00+02:00",
            },
            separators=(",", ":"),
        )
        parsed = _parse(line, line_no=2)
        self.assertIsInstance(parsed, CanonicalEvent)
        self.assertEqual(parsed.event_id, "99")
        self.assertEqual(parsed.repo_id, 15)
        self.assertEqual(parsed.event_time, "2024-01-01T06:30:00Z")
        self.assertEqual(parsed.actor_id, None)
        self.assertEqual(parsed.payload_action, None)
        self.assertEqual(parsed.repo_name, "a/b")

    def test_malformed_json_is_rejected(self):
        line = '{"id":'
        parsed = _parse(line, line_no=8)
        self.assertEqual(
            parsed,
            RejectedEvent(
                "malformed_json",
                "year=2026/month=11/day=25/hour=16/2026-11-25-16.json.gz",
                "2026-11-25T16:00:00Z",
                8,
                line,
            ),
        )

    def test_missing_repo_id_is_rejected(self):
        line = '{"id":"1","type":"WatchEvent","created_at":"2024-01-01T00:00:00Z"}'
        parsed = _parse(line, line_no=4)
        self.assertIsInstance(parsed, RejectedEvent)
        self.assertEqual(parsed.reason, "missing_repo_id")
        self.assertEqual(parsed.line_no, 4)
        self.assertEqual(parsed.excerpt, line)

    def test_blank_line_is_skipped(self):
        self.assertIsNone(_parse(""))
        self.assertIsNone(_parse("   \n"))

    def test_bool_repo_id_is_rejected(self):
        line = '{"id":"1","type":"WatchEvent","repo":{"id":true,"name":"a/b"},"created_at":"2024-01-01T00:00:00Z"}'
        parsed = _parse(line)
        self.assertIsInstance(parsed, RejectedEvent)
        self.assertEqual(parsed.reason, "missing_repo_id")

    def test_bad_timestamp_is_rejected(self):
        line = '{"id":"1","type":"WatchEvent","repo":{"id":10,"name":"a/b"},"created_at":"not-a-time"}'
        parsed = _parse(line, line_no=5)
        self.assertIsInstance(parsed, RejectedEvent)
        self.assertEqual(parsed.reason, "bad_event_time")
        self.assertEqual(parsed.excerpt, line)
        self.assertEqual(parsed.archive_hour, "2026-11-25T16:00:00Z")


if __name__ == "__main__":
    unittest.main()
