import { describe, expect, it } from "vitest";
import type { IssueGroup, LogEvent } from "../types";
import { buildIssueExport } from "./issueExport";

function event(index: number): LogEvent {
  return {
    timestamp: `2026-08-13T${String(8 + (index % 3)).padStart(2, "0")}:00:00+09:00`,
    ingestionTime: `2026-08-13T${String(8 + (index % 3)).padStart(2, "0")}:00:01+09:00`,
    timestampMs: 1000 - index,
    ingestionTimeMs: 1001 - index,
    logGroup: index % 2 ? "dev-refund" : "prod-example-api",
    logStream: `stream-${index}`,
    eventId: `event-${index}`,
    level: "ERROR",
    businessFailure: index % 2 === 0,
    message: `민감정보가 포함될 수 있는 원문 ${index}`,
  };
}

function issueGroup(): IssueGroup {
  const events = Array.from({ length: 35 }, (_, index) => event(index));
  const hourCounts = Array.from({ length: 24 }, () => 0);
  hourCounts[8] = 12;
  hourCounts[9] = 11;
  hourCounts[10] = 12;
  return {
    id: "issue-1",
    fingerprint: "fingerprint",
    title: "예약 처리 오류",
    count: events.length,
    events,
    logGroups: ["prod-example-api", "dev-refund"],
    firstSeen: events.at(-1)?.timestamp ?? "",
    lastSeen: events[0].timestamp,
    hourCounts,
  };
}

describe("AI 분석용 로그 내보내기", () => {
  it("화면 제한인 30건을 넘겨도 JSON에는 전체 이벤트를 포함한다", () => {
    const file = buildIssueExport(issueGroup(), "errors", "json", new Date("2026-08-13T05:00:00Z"));
    const payload = JSON.parse(file.contents);

    expect(file.suggestedName).toBe("log-morning_2026-08-13_ERROR_35events.json");
    expect(payload.issue.occurrenceCount).toBe(35);
    expect(payload.events).toHaveLength(35);
    expect(payload.events[34].message).toBe("민감정보가 포함될 수 있는 원문 34");
    expect(payload.privacyNotice).toContain("개인정보");
  });

  it("TXT 보고서에 요약, 시간대, 발생 위치와 전체 원문을 담는다", () => {
    const file = buildIssueExport(issueGroup(), "errors", "txt", new Date("2026-08-13T05:00:00Z"));

    expect(file.contents).toContain("총 발생 건수: 35건");
    expect(file.contents).toContain("08:00-08:59: 12건");
    expect(file.contents).toContain("- prod-example-api");
    expect(file.contents).toContain("화면의 최대 30건 표시 제한과 무관하게");
    expect(file.contents).toContain("민감정보가 포함될 수 있는 원문 34");
  });
});
