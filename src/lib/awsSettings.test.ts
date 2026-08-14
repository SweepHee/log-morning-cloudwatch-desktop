import { describe, expect, it } from "vitest";
import { DEFAULT_AWS_SETTINGS, hasMinimumBackupSettings, normalizeAwsSettings } from "./awsSettings";

describe("AWS 공개용 설정", () => {
  it("손상된 값을 안전한 기본값으로 정규화한다", () => {
    expect(normalizeAwsSettings({ authMode: "unknown", logGroups: "nope" })).toEqual(
      DEFAULT_AWS_SETTINGS,
    );
  });

  it("중복 로그 그룹을 제거한다", () => {
    const settings = normalizeAwsSettings({
      ...DEFAULT_AWS_SETTINGS,
      logGroups: ["/aws/one", "/aws/one", "/aws/two"],
    });
    expect(settings.logGroups).toEqual(["/aws/one", "/aws/two"]);
  });

  it("버킷과 리전이 있어야 백업 설정이 완료된다", () => {
    expect(hasMinimumBackupSettings(DEFAULT_AWS_SETTINGS)).toBe(false);
    expect(hasMinimumBackupSettings({ ...DEFAULT_AWS_SETTINGS, bucket: "my-log-bucket" })).toBe(true);
  });
});
