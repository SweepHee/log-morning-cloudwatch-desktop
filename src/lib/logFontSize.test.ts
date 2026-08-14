import { describe, expect, it } from "vitest";
import { normalizeLogFontSize } from "./logFontSize";

describe("실제 로그 글자 크기", () => {
  it("저장된 보통·크게 값을 복원한다", () => {
    expect(normalizeLogFontSize("medium")).toBe("medium");
    expect(normalizeLogFontSize("large")).toBe("large");
  });

  it("저장값이 없거나 잘못되면 기존 크기인 작게를 사용한다", () => {
    expect(normalizeLogFontSize(null)).toBe("small");
    expect(normalizeLogFontSize("huge")).toBe("small");
  });
});
