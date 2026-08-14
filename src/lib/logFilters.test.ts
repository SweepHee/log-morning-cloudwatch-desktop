import { describe, expect, it } from "vitest";
import type { LogEvent } from "../types";
import {
  environmentForLogGroup,
  filterLogEvents,
  matchesLogFilters,
} from "./logFilters";

function event(logGroup: string, logStream?: string): LogEvent {
  return {
    timestamp: "2026-08-11T10:00:00+09:00",
    ingestionTime: "2026-08-11T10:00:01+09:00",
    timestampMs: 1,
    ingestionTimeMs: 2,
    logGroup,
    logStream,
    level: "ERROR",
    businessFailure: false,
    message: "test",
  };
}

describe("로그 환경 분류", () => {
  it("prod와 production 그룹을 PROD로 분류한다", () => {
    expect(environmentForLogGroup("/ecs/example-api-prod")).toBe("prod");
    expect(environmentForLogGroup("production-notification-log-group")).toBe("prod");
  });

  it("dev 그룹은 DEV, 명시되지 않은 그룹은 미분류로 둔다", () => {
    expect(environmentForLogGroup("dev-refund-log-group")).toBe("dev");
    expect(environmentForLogGroup("backend-scheduler")).toBe("unknown");
  });
});

describe("로그 세부 필터", () => {
  const events = [
    event("/ecs/example-api-prod", "ecs/example/one"),
    event("/ecs/example-api-prod", "ecs/example/two"),
    event("dev-notification-log-group", "dev/notification/one"),
  ];

  it("환경, 로그 그룹, 스트림을 함께 적용한다", () => {
    const filtered = filterLogEvents(events, {
      environment: "prod",
      logGroup: "/ecs/example-api-prod",
      logStream: "ecs/example/two",
    });
    expect(filtered).toEqual([events[1]]);
  });

  it("전체 환경과 빈 선택값은 모든 이벤트를 허용한다", () => {
    expect(
      events.every((item) =>
        matchesLogFilters(item, { environment: "all", logGroup: "", logStream: "" }),
      ),
    ).toBe(true);
  });
});
