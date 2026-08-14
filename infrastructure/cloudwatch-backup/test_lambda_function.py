import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

import lambda_function as target


class BackupWindowTest(unittest.TestCase):
    def test_anchor_after_six_kst_uses_today(self):
        now_utc = datetime(2026, 8, 12, 1, 0, tzinfo=timezone.utc)  # 10:00 KST
        self.assertEqual("2026-08-12T06:00:00+09:00", target.anchor_for(now_utc).isoformat())

    def test_anchor_before_six_kst_uses_yesterday(self):
        now_utc = datetime(2026, 8, 11, 20, 0, tzinfo=timezone.utc)  # 05:00 KST
        self.assertEqual("2026-08-11T06:00:00+09:00", target.anchor_for(now_utc).isoformat())

    def test_builds_two_reconciliation_windows(self):
        anchor = datetime(2026, 8, 12, 6, 0, tzinfo=target.KST)
        windows = target.windows_for(anchor)
        self.assertEqual(2, len(windows))
        self.assertEqual("2026-08-10T06:00:00+09:00", windows[0].start_kst.isoformat())
        self.assertEqual("2026-08-11T06:00:00+09:00", windows[0].end_kst.isoformat())
        self.assertEqual("2026-08-11T06:00:00+09:00", windows[1].start_kst.isoformat())
        self.assertEqual("2026-08-12T06:00:00+09:00", windows[1].end_kst.isoformat())

    def test_current_window_after_six_runs_from_today_six_to_now(self):
        now_utc = datetime(2026, 8, 12, 1, 23, tzinfo=timezone.utc)  # 10:23 KST
        window = target.current_window_for(now_utc)
        self.assertEqual("2026-08-12T06:00:00+09:00", window.start_kst.isoformat())
        self.assertEqual("2026-08-12T10:23:00+09:00", window.end_kst.isoformat())
        self.assertIn("day=12/window=0600KST", window.s3_prefix)

    def test_current_window_before_six_uses_previous_log_day(self):
        now_utc = datetime(2026, 8, 11, 20, 30, tzinfo=timezone.utc)  # 05:30 KST
        window = target.current_window_for(now_utc)
        self.assertEqual("2026-08-11T06:00:00+09:00", window.start_kst.isoformat())
        self.assertEqual("2026-08-12T05:30:00+09:00", window.end_kst.isoformat())

    def test_current_mode_is_opt_in(self):
        self.assertEqual(target.MODE_DAILY, target.mode_for(None))
        self.assertEqual(target.MODE_DAILY, target.mode_for({"source": "eventbridge-scheduler"}))
        self.assertEqual(target.MODE_CURRENT, target.mode_for({"mode": "current"}))
        with self.assertRaises(ValueError):
            target.mode_for({"mode": "future"})


class ClassificationTest(unittest.TestCase):
    def test_warning_normalizes_to_warn(self):
        self.assertEqual("WARN", target.detect_level("[WARNING] test"))
        self.assertEqual("WARN", target.detect_level("[WARN] test"))

    def test_logback_error_is_detected(self):
        self.assertEqual("ERROR", target.detect_level("[worker-1] ERROR GuestService - failed"))

    def test_json_audit_failure_is_business_failure(self):
        self.assertTrue(target.is_business_failure('{"phase":"토스환불응답:실패","result":"실패"}'))

    def test_success_json_is_not_business_failure(self):
        self.assertFalse(target.is_business_failure('{"phase":"환불완료","result":"완료"}'))

    def test_success_json_with_failed_legs_key_is_not_business_failure(self):
        self.assertFalse(
            target.is_business_failure(
                '{"phase":"환불완료","result":"완료","failed_legs":[],"success_legs":["PG"]}'
            )
        )

    def test_success_response_with_error_field_names_is_not_business_failure(self):
        self.assertFalse(
            target.is_business_failure(
                '[FESTA 응답] body: {"status":"success","data":{"errorCd":"","errorMsg":""}}'
            )
        )

    def test_embedded_fail_status_is_business_failure(self):
        self.assertTrue(
            target.is_business_failure(
                '[FESTA 응답] body: {"status":"fail","data":{"errorCd":"ERR008"}}'
            )
        )


class SourceConfigurationTest(unittest.TestCase):
    def test_parses_group_and_optional_stream_selection(self):
        sources = target.load_log_sources(
            '[{"group":"/aws/lambda/example","streams":["new","old","new"]}]'
        )
        self.assertEqual(1, len(sources))
        self.assertEqual("/aws/lambda/example", sources[0]["group"])
        self.assertEqual(["new", "old"], sources[0]["streams"])
        self.assertTrue(sources[0]["alias"].startswith("01-aws-lambda-example-"))

    def test_rejects_duplicate_groups(self):
        with self.assertRaises(ValueError):
            target.load_log_sources('["/aws/lambda/example", "/aws/lambda/example"]')


class CloudWatchQueryTest(unittest.TestCase):
    def test_filter_log_events_uses_only_supported_parameters(self):
        calls = []

        class FakePaginator:
            def paginate(self, **kwargs):
                calls.append(kwargs)
                return []

        class FakeLogsClient:
            def get_paginator(self, operation_name):
                if operation_name != "filter_log_events":
                    raise AssertionError(f"unexpected paginator: {operation_name}")
                return FakePaginator()

        windows = target.windows_for(datetime(2026, 8, 12, 6, 0, tzinfo=target.KST))
        with TemporaryDirectory() as temp_dir:
            original_sources = target.LOG_SOURCES
            try:
                target.LOG_SOURCES = target.load_log_sources(
                    '[{"group":"/aws/lambda/example","streams":["latest"]}]'
                )
                _, _, errors = target._query_and_write(FakeLogsClient(), windows, Path(temp_dir))
            finally:
                target.LOG_SOURCES = original_sources

        self.assertEqual([], errors)
        self.assertEqual(1, len(calls))
        for call in calls:
            self.assertEqual(
                {"logGroupName", "logStreamNames", "startTime", "endTime"}, set(call)
            )
            self.assertEqual("/aws/lambda/example", call["logGroupName"])
            self.assertEqual(["latest"], call["logStreamNames"])


if __name__ == "__main__":
    unittest.main()
