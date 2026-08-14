import type { BackupDaySummary, DayLogData, LogEvent } from "../types";

const prefix = "daily/year=2026/month=08/day=11/window=0600KST";

function makeEvent(
  message: string,
  hour: number,
  index: number,
  level: "ERROR" | "WARN" | "INFO",
  logGroup = "/ecs/example-api-prod",
  businessFailure = false,
): LogEvent {
  const timestamp = `2026-08-11T${String(hour).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}:00+09:00`;
  return {
    timestamp,
    ingestionTime: timestamp,
    timestampMs: new Date(timestamp).getTime() + index,
    ingestionTimeMs: new Date(timestamp).getTime() + index + 1000,
    logGroup,
    logStream: "ecs/example-api/4b091a",
    eventId: `preview-${level}-${index}`,
    level,
    businessFailure,
    message,
  };
}

export const mockDays: BackupDaySummary[] = [
  {
    date: "2026-08-11",
    prefix,
    status: "complete",
    generatedAt: "2026-08-12T06:01:00+09:00",
    windowStartKst: "2026-08-11T06:00:00+09:00",
    windowEndKst: "2026-08-12T06:00:00+09:00",
    total: 10234,
    error: 164,
    warn: 61,
    businessFailure: 17,
    sourceErrorCount: 0,
  },
  {
    date: "2026-08-10",
    prefix: "daily/year=2026/month=08/day=10/window=0600KST",
    status: "complete",
    generatedAt: "2026-08-11T06:01:00+09:00",
    windowStartKst: "2026-08-10T06:00:00+09:00",
    windowEndKst: "2026-08-11T06:00:00+09:00",
    total: 10269,
    error: 243,
    warn: 25,
    businessFailure: 9,
    sourceErrorCount: 0,
  },
];

const errors = [
  ...Array.from({ length: 8 }, (_, index) =>
    makeEvent(
      `[http-nio-8080-exec-${index}] ERROR ReservationService - 예약 985${index} 조회 중 NullPointerException\njava.lang.NullPointerException: guest is null\n  at ReservationService.find(ReservationService.java:214)`,
      8 + (index % 3),
      index,
      "ERROR",
    ),
  ),
  ...Array.from({ length: 5 }, (_, index) =>
    makeEvent(
      `[payment-worker] ERROR TossPaymentClient - 외부 API 응답 지연: timeout after ${3000 + index * 100}ms`,
      14 + (index % 2),
      index + 20,
      "ERROR",
      "toss-pg-log",
    ),
  ),
  makeEvent(
    "org.springframework.dao.DataIntegrityViolationException: Duplicate entry for reservation",
    4,
    40,
    "ERROR",
  ),
];

const warnings = [
  ...Array.from({ length: 6 }, (_, index) =>
    makeEvent(
      `[scheduler] WARN ConnectionPool - DB connection pool 사용률이 ${80 + index}%를 넘었습니다`,
      20 + (index % 3),
      index + 60,
      "WARN",
      "prod-scheduler",
    ),
  ),
  ...Array.from({ length: 3 }, (_, index) =>
    makeEvent(
      "WARN SmsSender - SMS 공급자 응답이 느립니다",
      11,
      index + 70,
      "WARN",
      "prod-notification-log-group",
    ),
  ),
];

const businessFailures = [
  ...Array.from({ length: 7 }, (_, index) =>
    makeEvent(
      JSON.stringify({
        phase: "토스환불응답",
        result: "실패",
        fail_category: "사용자 잔액 부족",
        reservation_id: 10000 + index,
      }),
      16,
      index + 80,
      "INFO",
      "production-refund-log-group",
      true,
    ),
  ),
  ...Array.from({ length: 4 }, (_, index) =>
    makeEvent(
      JSON.stringify({
        phase: "예약일정변경",
        result: "부분실패",
        fail_reason: "알림 발송 실패",
      }),
      18,
      index + 90,
      "INFO",
      "production-schedule-change-log-group",
      true,
    ),
  ),
];

export const mockDayData: DayLogData = {
  summary: mockDays[0],
  all: [...errors, ...warnings, ...businessFailures],
  errors,
  warnings,
  businessFailures,
};
