import { describe, expect, it } from "vitest";
import { backupSourcesFor } from "./backupSources";

describe("Lambda 로그 소스 내보내기", () => {
  it("그룹 전체와 특정 스트림 선택을 배포 형식으로 변환한다", () => {
    expect(
      backupSourcesFor({
        authMode: "auto",
        profile: "",
        region: "ap-northeast-2",
        bucket: "example-backup",
        dailyPrefix: "log-morning/daily/",
        lambdaFunction: "log-morning-cloudwatch-backup",
        logGroups: ["/aws/lambda/example", "/ecs/api"],
        logStreams: { "/ecs/api": ["latest", "latest", " "] },
      }),
    ).toEqual([
      { group: "/aws/lambda/example" },
      { group: "/ecs/api", streams: ["latest"] },
    ]);
  });
});
