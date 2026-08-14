export type LogFontSize = "small" | "medium" | "large";

export const DEFAULT_LOG_FONT_SIZE: LogFontSize = "small";

export function normalizeLogFontSize(value: string | null): LogFontSize {
  if (value === "medium" || value === "large") return value;
  return DEFAULT_LOG_FONT_SIZE;
}
