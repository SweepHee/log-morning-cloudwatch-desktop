import { describe, expect, it } from "vitest";
import { normalizeSidebarCollapsed } from "./sidebarState";

describe("normalizeSidebarCollapsed", () => {
  it("restores a collapsed sidebar", () => {
    expect(normalizeSidebarCollapsed("true")).toBe(true);
  });

  it("keeps the sidebar open for missing or invalid values", () => {
    expect(normalizeSidebarCollapsed(null)).toBe(false);
    expect(normalizeSidebarCollapsed("false")).toBe(false);
    expect(normalizeSidebarCollapsed("collapsed")).toBe(false);
  });
});
