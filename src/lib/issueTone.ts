import type { IssueGroup, LogTab } from "../types";

export type IssueTone = "info" | "error" | "warning" | "business";

export function issueToneFor(group: IssueGroup, tab: LogTab): IssueTone {
  if (tab === "businessFailures") return "business";

  const levels = new Set(group.events.map((event) => event.level.trim().toUpperCase()));
  if (levels.has("ERROR")) return "error";
  if (levels.has("WARN") || levels.has("WARNING")) return "warning";
  return "info";
}
