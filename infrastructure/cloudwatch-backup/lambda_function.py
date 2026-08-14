"""CloudWatch Logs 일일 백업 Lambda.

3줄 요약
=========
1. 이 Lambda는 지워도 괜찮다. 운영 서비스에 전혀 영향을 주지 않는다.
2. 현재 실행량 기준 비용은 0원에 가깝고, 무료 구간을 초과해도 월 100원 안팎이다.
3. 백엔드에서 발생하는 각종 ERROR, WARN 및 업무 실패 로그를 S3에 백업하는 프로그램이다.

중요 — 용도와 안전한 삭제 범위
===============================
이 함수는 운영 비즈니스 로직이 아니며 고객 요청을 처리하지 않는다.
선택된 CloudWatch Logs를 비공개 S3 백업 버킷으로 복사하는 일만 한다.
회사가 이 백업을 더 이상 사용하지 않는다면 이 Lambda와 EventBridge Scheduler,
관련 IAM 역할을 함께 삭제해도 된다. 삭제하면 미래의 백업만 중단되며, 이미 S3에
저장된 객체는 누군가 버킷 또는 객체를 별도로 삭제하기 전까지 그대로 남는다.

비용 메모 (2026-08-12 확인 기준, AWS 요금은 변경될 수 있음)
==========================================================
* Lambda는 만들어 둔 것만으로 과금되지 않으며 요청 수와 실행시간만 과금된다.
* 월간 Lambda 무료 구간은 AWS 계정 전체가 공유한다. 요청 1,000,000회와
  400,000GB-초이며, 이 작업은 보통 월 약 30회 실행된다.
* 메모리 512MB에서 매일 1분 실행하면 월 약 900GB-초다. 공유 무료 구간을 이미
  소진했다고 가정할 때 당시 서울 arm64 1단계 요금은 GB-초당 $0.0000133334였다.
  회당 1분이면 월 약 $0.012, 회당 10분이면 월 약 $0.12다.
* EventBridge Scheduler의 공유 무료 구간은 당시 월 14,000,000회였고 이 스케줄은
  월 약 30회를 사용한다. S3 저장·요청과 CloudWatch 사용 비용은 별도다.
* 이 수치를 근거로 판단하기 전에는 반드시 AWS 공식 최신 요금표를 다시 확인한다.

백업 구간은 한국 표준시를 사용하고 시작 포함·끝 제외 구간이다.
    [전날 06:00 KST, 오늘 06:00 KST)

정기 실행은 매번 가장 최근 두 구간을 다시 만든다. 최근 48시간을 재조회함으로써
전날 06시 실행 직후 CloudWatch에 늦게 수집된 이벤트도 다음 실행에서 보완한다.

데스크톱 앱이 ``{"mode":"current"}`` 로 호출하면 가장 최근 06:00 KST부터 호출
시각까지의 진행 중 스냅샷을 만든다. 같은 날짜의 파일명은 항상 동일하므로 첫
호출은 새 파일을 만들고 이후 호출은 전체 스냅샷을 최신 상태로 덮어쓴다. 진행 중
스냅샷은 ``_LIVE`` 로, 완결된 일일 백업은 ``_SUCCESS`` 로 구분한다.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import re
import tempfile
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    import boto3
except ModuleNotFoundError:  # Lambda 외부에서도 순수 헬퍼 단위 테스트를 실행하기 위함.
    boto3 = None


LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

KST = timezone(timedelta(hours=9), "KST")
WINDOW_HOUR_KST = 6
RECONCILIATION_WINDOW_COUNT = 2
MODE_DAILY = "daily"
MODE_CURRENT = "current"
SUCCESS_MARKER = "_SUCCESS"
LIVE_MARKER = "_LIVE"

BACKUP_BUCKET = os.environ.get("BACKUP_BUCKET", "").strip()
BACKUP_PREFIX = os.environ.get("BACKUP_PREFIX", "log-morning/daily").strip("/")


def _source_alias(group: str, index: int) -> str:
    """S3 파일명에 사용할 충돌 없는 로그 그룹 별칭을 만든다."""
    readable = re.sub(r"[^a-zA-Z0-9]+", "-", group).strip("-").lower()[:48] or "log-group"
    digest = hashlib.sha256(group.encode("utf-8")).hexdigest()[:8]
    return f"{index + 1:02d}-{readable}-{digest}"


def load_log_sources(serialized: str) -> Tuple[Dict[str, Any], ...]:
    """환경 변수의 공개용 로그 그룹 설정을 검증한다.

    형식: [{"group":"/aws/lambda/api","streams":["optional-stream"]}]
    streams가 비어 있으면 해당 로그 그룹 전체를 백업한다.
    """
    if not serialized.strip():
        return ()
    try:
        values = json.loads(serialized)
    except json.JSONDecodeError as exc:
        raise ValueError("LOG_SOURCES_JSON must be valid JSON") from exc
    if not isinstance(values, list) or not values:
        raise ValueError("LOG_SOURCES_JSON must contain at least one log group")
    if len(values) > 100:
        raise ValueError("A maximum of 100 log groups can be backed up")

    sources: List[Dict[str, Any]] = []
    seen_groups = set()
    for index, value in enumerate(values):
        if isinstance(value, str):
            value = {"group": value}
        if not isinstance(value, dict):
            raise ValueError("Each log source must be a string or object")
        group = str(value.get("group", "")).strip()
        if not group or len(group) > 512 or group in seen_groups:
            raise ValueError("Each log group must be non-empty, unique, and at most 512 characters")
        raw_streams = value.get("streams", [])
        if not isinstance(raw_streams, list) or not all(isinstance(stream, str) for stream in raw_streams):
            raise ValueError("streams must be an array of strings")
        streams = sorted({stream.strip() for stream in raw_streams if stream.strip()})
        if len(streams) > 100:
            raise ValueError("CloudWatch FilterLogEvents supports at most 100 streams per group")
        sources.append(
            {
                "alias": _source_alias(group, index),
                "group": group,
                "streams": streams,
                "default_level": str(value.get("default_level", "UNKNOWN")).upper(),
            }
        )
        seen_groups.add(group)
    return tuple(sources)


LOG_SOURCES = load_log_sources(os.environ.get("LOG_SOURCES_JSON", ""))

LEVEL_RE = re.compile(r"(?<![A-Z])(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)(?![A-Z])", re.IGNORECASE)
# ERROR는 별도 필터에서 이미 제공한다. 여기서 ERROR까지 찾으면 JSON의 errorMsg 같은
# 필드명만으로 성공 응답까지 업무실패가 되는 오탐이 생기므로, 명시적인 실패 표현만 본다.
FAILURE_TEXT_RE = re.compile(r"부분실패|실패|예외|(?<![A-Z])FAIL(?:ED)?(?![A-Z])", re.IGNORECASE)
FAILURE_VALUES = {"실패", "부분실패", "fail", "failed", "error", "partial_failure"}


@dataclass(frozen=True)
class BackupWindow:
    start_kst: datetime
    end_kst: datetime

    @property
    def identifier(self) -> str:
        return self.start_kst.date().isoformat()

    @property
    def s3_prefix(self) -> str:
        start_date = self.start_kst.date()
        return (
            f"{BACKUP_PREFIX}/year={start_date.year:04d}/month={start_date.month:02d}/"
            f"day={start_date.day:02d}/window=0600KST"
        )


def anchor_for(now: datetime) -> datetime:
    """현재 시각과 같거나 그 이전인 가장 최근 06:00 KST 기준점을 반환한다."""
    now_kst = now.astimezone(KST)
    anchor = datetime.combine(now_kst.date(), time(WINDOW_HOUR_KST), tzinfo=KST)
    if now_kst < anchor:
        anchor -= timedelta(days=1)
    return anchor


def windows_for(anchor_kst: datetime) -> Tuple[BackupWindow, ...]:
    """직전 두 개의 일일 구간을 오래된 순서로 만든다."""
    if anchor_kst.tzinfo is None:
        raise ValueError("anchor_kst must be timezone-aware")
    anchor_kst = anchor_kst.astimezone(KST)
    return tuple(
        BackupWindow(
            start_kst=anchor_kst - timedelta(days=offset),
            end_kst=anchor_kst - timedelta(days=offset - 1),
        )
        for offset in range(RECONCILIATION_WINDOW_COUNT, 0, -1)
    )


def current_window_for(now: datetime) -> BackupWindow:
    """가장 최근 06:00 KST부터 현재까지의 진행 중 로그 구간을 반환한다."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now_kst = now.astimezone(KST)
    return BackupWindow(start_kst=anchor_for(now_kst), end_kst=now_kst)


def mode_for(event: Optional[Dict[str, Any]]) -> str:
    """수동 호출 모드를 검증한다. 스케줄러와 기존 수동 호출은 항상 daily다."""
    mode = str((event or {}).get("mode", MODE_DAILY)).strip().lower()
    if mode not in {MODE_DAILY, MODE_CURRENT}:
        raise ValueError(f"unsupported backup mode: {mode}")
    return mode


def parse_anchor(event: Optional[Dict[str, Any]], now_utc: datetime) -> datetime:
    """통제된 과거 백업과 수동 검증을 위해 KST 기준일을 직접 지정할 수 있게 한다."""
    anchor_date_text = (event or {}).get("anchor_date_kst")
    if not anchor_date_text:
        return anchor_for(now_utc)
    parsed_date = date.fromisoformat(str(anchor_date_text))
    return datetime.combine(parsed_date, time(WINDOW_HOUR_KST), tzinfo=KST)


def detect_level(message: str, default_level: str = "UNKNOWN") -> str:
    """Appender 패턴에 Logback 레벨이 남아 있으면 그 레벨을 추출한다."""
    match = LEVEL_RE.search(message[:500])
    if not match:
        return default_level
    level = match.group(1).upper()
    return "WARN" if level == "WARNING" else level


def _json_message(message: str) -> Optional[Dict[str, Any]]:
    stripped = message.strip()
    if not stripped.startswith("{"):
        return None
    try:
        parsed = json.loads(stripped)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def is_business_failure(message: str) -> bool:
    """INFO로만 기록되는 감사 로그 안의 업무 실패를 추가로 판별한다."""
    parsed = _json_message(message)
    if parsed:
        for key in ("result", "status"):
            value = parsed.get(key)
            if value is not None and str(value).strip().lower() in FAILURE_VALUES:
                return True
        phase = str(parsed.get("phase", ""))
        if "실패" in phase or "FAIL" in phase.upper() or "ERROR" in phase.upper():
            return True
        for key in ("fail_reason", "fail_category", "error"):
            if parsed.get(key) not in (None, "", [], {}):
                return True
        # 구조화된 감사 로그는 키 이름(failed_legs, errorMsg 등)에 실패 문자열이
        # 들어갈 수 있으므로 전체 JSON 텍스트를 다시 검색하지 않는다.
        return False
    return bool(FAILURE_TEXT_RE.search(message))


def window_for_timestamp(timestamp_ms: int, windows: Iterable[BackupWindow]) -> Optional[BackupWindow]:
    timestamp = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).astimezone(KST)
    for window in windows:
        if window.start_kst <= timestamp < window.end_kst:
            return window
    return None


def event_record(event: Dict[str, Any], source: Dict[str, str]) -> Dict[str, Any]:
    timestamp_ms = int(event["timestamp"])
    ingestion_time_ms = int(event.get("ingestionTime", timestamp_ms))
    message = str(event.get("message", ""))
    return {
        "timestamp": datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).astimezone(KST).isoformat(),
        "ingestion_time": datetime.fromtimestamp(ingestion_time_ms / 1000, tz=timezone.utc)
        .astimezone(KST)
        .isoformat(),
        "timestamp_ms": timestamp_ms,
        "ingestion_time_ms": ingestion_time_ms,
        "log_group": source["group"],
        "log_stream": event.get("logStreamName"),
        "event_id": event.get("eventId"),
        "level": detect_level(message, source.get("default_level", "UNKNOWN")),
        "business_failure": is_business_failure(message),
        "message": message,
    }


def _write_jsonl(handle: Any, value: Dict[str, Any]) -> None:
    handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    handle.write("\n")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _upload_gzip(s3_client: Any, path: Path, key: str, window: BackupWindow) -> Dict[str, Any]:
    with path.open("rb") as body:
        s3_client.put_object(
            Bucket=BACKUP_BUCKET,
            Key=key,
            Body=body,
            ContentType="application/x-ndjson",
            ContentEncoding="gzip",
            ServerSideEncryption="AES256",
            Metadata={
                "window-start-kst": window.start_kst.isoformat(),
                "window-end-kst": window.end_kst.isoformat(),
                "purpose": "cloudwatch-daily-log-backup",
            },
        )
    return {"key": key, "bytes": path.stat().st_size, "sha256": _sha256(path)}


def _put_manifest(s3_client: Any, window: BackupWindow, manifest: Dict[str, Any]) -> None:
    s3_client.put_object(
        Bucket=BACKUP_BUCKET,
        Key=f"{window.s3_prefix}/manifest.json",
        Body=json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
        ServerSideEncryption="AES256",
    )


def _put_marker(s3_client: Any, window: BackupWindow, marker: str) -> None:
    if marker not in {SUCCESS_MARKER, LIVE_MARKER}:
        raise ValueError(f"unsupported marker: {marker}")
    s3_client.put_object(
        Bucket=BACKUP_BUCKET,
        Key=f"{window.s3_prefix}/{marker}",
        Body=b"",
        ContentType="text/plain",
        ServerSideEncryption="AES256",
        Metadata={
            "purpose": "cloudwatch-daily-log-backup",
            "backup-state": "live" if marker == LIVE_MARKER else "complete",
        },
    )


def _delete_markers(
    s3_client: Any,
    windows: Iterable[BackupWindow],
    markers: Iterable[str],
) -> None:
    # 재실행 도중에는 기존 표시를 지워 여러 파일이 섞인 스냅샷을 읽지 못하게 한다.
    for window in windows:
        for marker in markers:
            if marker not in {SUCCESS_MARKER, LIVE_MARKER}:
                raise ValueError(f"unsupported marker: {marker}")
            s3_client.delete_object(Bucket=BACKUP_BUCKET, Key=f"{window.s3_prefix}/{marker}")


def _initial_counts(windows: Iterable[BackupWindow]) -> Dict[str, Dict[str, Any]]:
    return {
        window.identifier: {
            "total": 0,
            "error": 0,
            "warn": 0,
            "business_failure": 0,
            "by_source": {source["alias"]: 0 for source in LOG_SOURCES},
        }
        for window in windows
    }


def _query_and_write(
    logs_client: Any,
    windows: Tuple[BackupWindow, ...],
    temp_root: Path,
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Path]], List[Dict[str, str]]]:
    counts = _initial_counts(windows)
    paths: Dict[str, Dict[str, Path]] = {}
    errors: List[Dict[str, str]] = []

    query_start_ms = int(windows[0].start_kst.timestamp() * 1000)
    query_end_ms = int(windows[-1].end_kst.timestamp() * 1000) - 1

    with ExitStack() as stack:
        filter_handles: Dict[str, Dict[str, Any]] = {}
        for window in windows:
            window_dir = temp_root / window.identifier
            raw_dir = window_dir / "raw"
            filtered_dir = window_dir / "filtered"
            raw_dir.mkdir(parents=True, exist_ok=True)
            filtered_dir.mkdir(parents=True, exist_ok=True)
            paths[window.identifier] = {}
            filter_handles[window.identifier] = {}
            for filter_name in ("error", "warn", "business-failure"):
                filter_path = filtered_dir / f"{filter_name}.jsonl.gz"
                paths[window.identifier][f"filtered/{filter_name}"] = filter_path
                filter_handles[window.identifier][filter_name] = stack.enter_context(
                    gzip.open(filter_path, "wt", encoding="utf-8")
                )

        for source in LOG_SOURCES:
            raw_handles: Dict[str, Any] = {}
            for window in windows:
                raw_path = temp_root / window.identifier / "raw" / f"{source['alias']}.jsonl.gz"
                paths[window.identifier][f"raw/{source['alias']}"] = raw_path
                raw_handles[window.identifier] = stack.enter_context(gzip.open(raw_path, "wt", encoding="utf-8"))

            try:
                paginator = logs_client.get_paginator("filter_log_events")
                query = {
                    "logGroupName": source["group"],
                    "startTime": query_start_ms,
                    "endTime": query_end_ms,
                }
                if source["streams"]:
                    query["logStreamNames"] = source["streams"]
                pages = paginator.paginate(**query)
                for page in pages:
                    for event in page.get("events", []):
                        window = window_for_timestamp(int(event["timestamp"]), windows)
                        if window is None:
                            continue
                        record = event_record(event, source)
                        window_id = window.identifier
                        _write_jsonl(raw_handles[window_id], record)
                        counts[window_id]["total"] += 1
                        counts[window_id]["by_source"][source["alias"]] += 1

                        if record["level"] == "ERROR":
                            _write_jsonl(filter_handles[window_id]["error"], record)
                            counts[window_id]["error"] += 1
                        if record["level"] == "WARN":
                            _write_jsonl(filter_handles[window_id]["warn"], record)
                            counts[window_id]["warn"] += 1
                        if record["business_failure"]:
                            _write_jsonl(filter_handles[window_id]["business-failure"], record)
                            counts[window_id]["business_failure"] += 1
            except Exception as exc:  # Keep partial files and make the manifest explicit.
                LOGGER.exception("Failed to back up log group %s", source["group"])
                errors.append({"log_group": source["group"], "error": f"{type(exc).__name__}: {exc}"})

    return counts, paths, errors


def lambda_handler(event: Optional[Dict[str, Any]], context: Any) -> Dict[str, Any]:
    if boto3 is None:
        raise RuntimeError("boto3 is required in the Lambda runtime")
    if not BACKUP_BUCKET:
        raise RuntimeError("BACKUP_BUCKET must be configured")
    if not LOG_SOURCES:
        raise RuntimeError("LOG_SOURCES_JSON must contain at least one selected log group")

    now_utc = datetime.now(timezone.utc)
    mode = mode_for(event)
    if mode == MODE_CURRENT:
        windows = (current_window_for(now_utc),)
        anchor_kst = windows[0].start_kst
        marker = LIVE_MARKER
        markers_to_delete = (LIVE_MARKER,)
    else:
        anchor_kst = parse_anchor(event, now_utc)
        windows = windows_for(anchor_kst)
        marker = SUCCESS_MARKER
        # 오전 6시 정기 백업이 같은 날짜의 진행 중 스냅샷을 최종 완료본으로 승격한다.
        markers_to_delete = (SUCCESS_MARKER, LIVE_MARKER)
    # Lambda 실행 환경이 제공하는 리전을 그대로 사용한다. 특정 회사/리전에 묶지 않는다.
    logs_client = boto3.client("logs", region_name=os.environ.get("AWS_REGION"))
    s3_client = boto3.client("s3", region_name=os.environ.get("AWS_REGION"))

    LOGGER.info(
        "CloudWatch backup started: bucket=%s mode=%s anchor=%s windows=%s",
        BACKUP_BUCKET,
        mode,
        anchor_kst.isoformat(),
        [window.identifier for window in windows],
    )

    _delete_markers(s3_client, windows, markers_to_delete)

    with tempfile.TemporaryDirectory(prefix="log-morning-backup-") as temp_dir:
        counts, paths, errors = _query_and_write(logs_client, windows, Path(temp_dir))
        uploaded_by_window: Dict[str, List[Dict[str, Any]]] = {}

        for window in windows:
            window_id = window.identifier
            generated_at = datetime.now(timezone.utc).astimezone(KST).isoformat()
            uploaded_files: List[Dict[str, Any]] = []
            for relative_name, local_path in sorted(paths[window_id].items()):
                key = f"{window.s3_prefix}/{relative_name}.jsonl.gz"
                uploaded_files.append(_upload_gzip(s3_client, local_path, key, window))
            uploaded_by_window[window_id] = uploaded_files

            manifest = {
                "schema_version": 1,
                "status": "partial" if errors else ("in_progress" if mode == MODE_CURRENT else "complete"),
                "backup_mode": mode,
                "purpose": "CloudWatch 일일 로그 백업 전용이며 운영 비즈니스 로직이 아님",
                "safe_deletion_note": (
                    "이 백업이 더 이상 필요 없다면 Lambda/스케줄/IAM 역할을 삭제해도 됨. "
                    "기존 S3 백업 객체는 별도로 삭제하기 전까지 유지됨."
                ),
                "generated_at": generated_at,
                "window_start_kst": window.start_kst.isoformat(),
                "window_end_kst": window.end_kst.isoformat(),
                "expected_window_end_kst": (window.start_kst + timedelta(days=1)).isoformat(),
                "window_semantics": "start inclusive, end exclusive",
                "reconciliation_windows_per_run": len(windows),
                "completion_marker": marker,
                "lambda_request_id": getattr(context, "aws_request_id", None),
                "counts": counts[window_id],
                "source_errors": errors,
                "files": uploaded_files,
            }
            _put_manifest(s3_client, window, manifest)
            if not errors:
                _put_marker(s3_client, window, marker)

    result = {
        "status": "partial" if errors else "complete",
        "mode": mode,
        "anchor_kst": anchor_kst.isoformat(),
        "windows": [
            {
                "start": window.start_kst.isoformat(),
                "end": window.end_kst.isoformat(),
                "s3_prefix": window.s3_prefix,
                "counts": counts[window.identifier],
                "uploaded_files": len(uploaded_by_window[window.identifier]),
            }
            for window in windows
        ],
        "source_errors": errors,
    }
    LOGGER.info("CloudWatch backup finished: %s", json.dumps(result, ensure_ascii=False))

    if errors:
        raise RuntimeError(f"CloudWatch backup was partial for {len(errors)} log group(s): {errors}")
    return result
