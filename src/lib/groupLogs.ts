import type { IssueGroup, LogEvent } from "../types";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ISO_DATE_RE = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?<!\d)(?:01[016789]|02|0[3-6][1-5])[-\s]?\d{3,4}[-\s]?\d{4}(?!\d)/g;
const LONG_NUMBER_RE = /\b\d{4,}\b/g;
const HEX_RE = /\b(?:0x)?[0-9a-f]{12,}\b/gi;

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function redactSummary(value: string): string {
  return value
    .replace(EMAIL_RE, "[이메일]")
    .replace(PHONE_RE, "[전화번호]")
    .replace(UUID_RE, "[UUID]")
    .replace(HEX_RE, "[식별자]")
    .replace(LONG_NUMBER_RE, "[번호]");
}

function jsonTitle(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    const pieces = [
      value.phase,
      value.result ?? value.status,
      value.fail_category,
      value.fail_reason,
      value.error,
    ]
      .filter((piece) => piece !== undefined && piece !== null && String(piece).trim())
      .map(String);
    return pieces.length ? compact(pieces.join(" · ")) : null;
  } catch {
    return null;
  }
}

export function titleForEvent(event: LogEvent): string {
  const fromJson = jsonTitle(event.message);
  if (fromJson) return redactSummary(fromJson).slice(0, 150);

  const lines = event.message
    .split("\n")
    .map((line) => compact(line))
    .filter(Boolean);
  const first = lines[0] ?? "내용 없는 로그";
  const causedBy = lines.find((line) => /^caused by:/i.test(line));
  const title = causedBy && !first.toLowerCase().includes("exception") ? `${first} · ${causedBy}` : first;
  return redactSummary(title).slice(0, 150);
}

export function fingerprintForEvent(event: LogEvent): string {
  const title = titleForEvent(event)
    .toLowerCase()
    .replace(UUID_RE, "<uuid>")
    .replace(ISO_DATE_RE, "<date>")
    .replace(EMAIL_RE, "<email>")
    .replace(PHONE_RE, "<phone>")
    .replace(HEX_RE, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return `${event.logGroup}::${title}`;
}

function hourInKst(timestamp: string): number {
  const match = timestamp.match(/T(\d{2}):/);
  const hour = match ? Number(match[1]) : -1;
  return hour >= 0 && hour <= 23 ? hour : 0;
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function groupEvents(events: LogEvent[]): IssueGroup[] {
  const grouped = new Map<string, LogEvent[]>();
  for (const event of events) {
    const fingerprint = fingerprintForEvent(event);
    const bucket = grouped.get(fingerprint);
    if (bucket) bucket.push(event);
    else grouped.set(fingerprint, [event]);
  }

  return Array.from(grouped.entries())
    .map(([fingerprint, bucket]) => {
      const sorted = [...bucket].sort((left, right) => right.timestampMs - left.timestampMs);
      const hourCounts = Array.from({ length: 24 }, () => 0);
      for (const event of bucket) hourCounts[hourInKst(event.timestamp)] += 1;
      return {
        id: stableId(fingerprint),
        fingerprint,
        title: titleForEvent(sorted[0]),
        count: sorted.length,
        events: sorted,
        logGroups: Array.from(new Set(sorted.map((event) => event.logGroup))),
        lastSeen: sorted[0]?.timestamp ?? "",
        firstSeen: sorted.at(-1)?.timestamp ?? "",
        hourCounts,
      };
    })
    .sort((left, right) => right.count - left.count || right.lastSeen.localeCompare(left.lastSeen));
}

export function matchesSearch(group: IssueGroup, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return (
    group.title.toLowerCase().includes(needle) ||
    group.logGroups.some((logGroup) => logGroup.toLowerCase().includes(needle)) ||
    group.events.some((event) => event.message.toLowerCase().includes(needle))
  );
}
