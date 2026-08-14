import { describe, expect, it } from "vitest";
import type { LogEvent } from "../types";
import { fingerprintForEvent, groupEvents, titleForEvent } from "./groupLogs";

function event(message: string, overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    timestamp: "2026-08-11T10:00:00+09:00",
    ingestionTime: "2026-08-11T10:00:01+09:00",
    timestampMs: 1,
    ingestionTimeMs: 2,
    logGroup: "/ecs/example-api-prod",
    level: "ERROR",
    businessFailure: false,
    message,
    ...overrides,
  };
}

describe("로그 그룹화", () => {
  it("서로 다른 숫자 식별값을 같은 오류로 묶는다", () => {
    const first = event("Reservation 12345 was not found");
    const second = event("Reservation 98765 was not found", { timestampMs: 3 });
    expect(fingerprintForEvent(first)).toBe(fingerprintForEvent(second));
    expect(groupEvents([first, second])[0].count).toBe(2);
  });

  it("요약 제목에서 이메일과 전화번호를 가린다", () => {
    expect(titleForEvent(event("user@test.com / 010-1234-5678 처리 실패"))).toBe(
      "[이메일] / [전화번호] 처리 실패",
    );
  });

  it("JSON 업무실패 로그에서 사람이 읽을 제목을 만든다", () => {
    expect(
      titleForEvent(event('{"phase":"토스환불응답","result":"실패","fail_reason":"잔액 부족"}')),
    ).toBe("토스환불응답 · 실패 · 잔액 부족");
  });
});
