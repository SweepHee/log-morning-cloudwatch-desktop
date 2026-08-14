import { describe, expect, it } from "vitest";
import type { IssueGroup, LogEvent, LogTab } from "../types";
import { issueToneFor } from "./issueTone";

function group(levels: string[]): IssueGroup {
  const events = levels.map(
    (level, index): LogEvent => ({
      timestamp: `2026-08-13T10:00:0${index}+09:00`,
      ingestionTime: `2026-08-13T10:00:0${index}+09:00`,
      timestampMs: index,
      ingestionTimeMs: index,
      logGroup: "/ecs/example-api-prod",
      level,
      businessFailure: false,
      message: "test",
    }),
  );

  return {
    id: "test",
    fingerprint: "test",
    title: "test",
    count: events.length,
    events,
    logGroups: ["/ecs/example-api-prod"],
    lastSeen: events[0]?.timestamp ?? "",
    firstSeen: events[0]?.timestamp ?? "",
    hourCounts: Array.from({ length: 24 }, () => 0),
  };
}

describe("선택 로그 강조색", () => {
  it.each<[LogTab, string[], string]>([
    ["all", ["INFO"], "info"],
    ["all", ["WARN"], "warning"],
    ["warnings", ["WARNING"], "warning"],
    ["errors", ["ERROR"], "error"],
    ["businessFailures", ["INFO"], "business"],
  ])("%s 탭의 %s 로그를 %s 색으로 표시한다", (tab, levels, tone) => {
    expect(issueToneFor(group(levels), tab)).toBe(tone);
  });

  it("한 유형에 여러 레벨이 섞이면 가장 강한 ERROR 색을 사용한다", () => {
    expect(issueToneFor(group(["INFO", "WARN", "ERROR"]), "all")).toBe("error");
  });
});
