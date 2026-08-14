import type { IssueGroup, LogEvent, LogTab } from "../types";

export type IssueExportFormat = "txt" | "json";

export interface IssueExportFile {
  contents: string;
  extension: IssueExportFormat;
  suggestedName: string;
}

const tabLabels: Record<LogTab, { code: string; label: string }> = {
  all: { code: "ALL", label: "전체 로그" },
  errors: { code: "ERROR", label: "에러 로그" },
  warnings: { code: "WARNING", label: "경고 로그" },
  businessFailures: { code: "BUSINESS_FAILURE", label: "업무실패 로그" },
};

const logDayHours = [
  ...Array.from({ length: 18 }, (_, index) => index + 6),
  ...Array.from({ length: 6 }, (_, index) => index),
];

function kstDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} KST`;
}

function displayTimestamp(timestamp: string): string {
  return timestamp ? timestamp.replace("T", " ") : "-";
}

function eventForJson(event: LogEvent, index: number) {
  return {
    number: index + 1,
    timestampKst: event.timestamp,
    ingestionTimeKst: event.ingestionTime,
    timestampMs: event.timestampMs,
    ingestionTimeMs: event.ingestionTimeMs,
    logGroup: event.logGroup,
    logStream: event.logStream ?? null,
    eventId: event.eventId ?? null,
    level: event.level,
    businessFailure: event.businessFailure,
    message: event.message,
  };
}

function hourlyOccurrences(group: IssueGroup) {
  return logDayHours.map((hour) => ({
    hourKst: `${String(hour).padStart(2, "0")}:00-${String(hour).padStart(2, "0")}:59`,
    count: group.hourCounts[hour] ?? 0,
  }));
}

function filenameDate(group: IssueGroup): string {
  const match = (group.lastSeen || group.firstSeen).match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? "undated";
}

function buildJson(group: IssueGroup, tab: LogTab, exportedAt: Date): string {
  const tabInfo = tabLabels[tab];
  return JSON.stringify(
    {
      schemaVersion: 1,
      documentType: "log-morning-ai-analysis-export",
      description: "로그 모닝에서 선택한 동일 유형 로그의 전체 발생 내역",
      exportedAtKst: kstDateTime(exportedAt),
      privacyNotice: "로그 원문에는 이름, 이메일, 전화번호 등 개인정보가 포함될 수 있습니다.",
      eventOrder: "newest-first",
      issue: {
        category: tabInfo.code,
        categoryLabel: tabInfo.label,
        title: group.title,
        occurrenceCount: group.count,
        firstSeenKst: group.firstSeen,
        lastSeenKst: group.lastSeen,
        logGroups: group.logGroups,
        hourlyOccurrencesKst: hourlyOccurrences(group),
      },
      events: group.events.map(eventForJson),
    },
    null,
    2,
  );
}

function eventForText(event: LogEvent, index: number): string {
  return [
    `#${String(index + 1).padStart(3, "0")}`,
    `발생 시각(KST): ${displayTimestamp(event.timestamp)}`,
    `수집 시각(KST): ${displayTimestamp(event.ingestionTime)}`,
    `로그 그룹: ${event.logGroup || "-"}`,
    `로그 스트림: ${event.logStream ?? "-"}`,
    `이벤트 ID: ${event.eventId ?? "-"}`,
    `레벨: ${event.level || "-"}`,
    `업무실패: ${event.businessFailure ? "예" : "아니요"}`,
    "원문:",
    event.message,
  ].join("\n");
}

function buildText(group: IssueGroup, tab: LogTab, exportedAt: Date): string {
  const tabInfo = tabLabels[tab];
  const hourly = hourlyOccurrences(group)
    .filter(({ count }) => count > 0)
    .map(({ hourKst, count }) => `- ${hourKst}: ${count.toLocaleString("ko-KR")}건`)
    .join("\n");
  const sources = group.logGroups.map((logGroup) => `- ${logGroup}`).join("\n");
  const events = group.events.map(eventForText).join("\n\n------------------------------------------------------------\n\n");

  return [
    "로그 모닝 - AI 분석용 전체 로그 보고서",
    "============================================================",
    "주의: 로그 원문에는 이름, 이메일, 전화번호 등 개인정보가 포함될 수 있습니다.",
    "",
    "[분석 대상]",
    `분류: ${tabInfo.label} (${tabInfo.code})`,
    `로그 유형: ${group.title}`,
    `총 발생 건수: ${group.count.toLocaleString("ko-KR")}건`,
    `최초 발생(KST): ${displayTimestamp(group.firstSeen)}`,
    `최근 발생(KST): ${displayTimestamp(group.lastSeen)}`,
    `파일 생성(KST): ${kstDateTime(exportedAt)}`,
    "정렬: 최근 발생 순",
    "",
    "[시간대별 발생량(KST)]",
    hourly || "- 발생 기록 없음",
    "",
    "[발생 위치]",
    sources || "- 로그 그룹 정보 없음",
    "",
    `[전체 이벤트: ${group.events.length.toLocaleString("ko-KR")}건]`,
    "화면의 최대 30건 표시 제한과 무관하게 이 파일에는 선택한 유형의 전체 이벤트가 포함됩니다.",
    "",
    events,
    "",
  ].join("\n");
}

export function buildIssueExport(
  group: IssueGroup,
  tab: LogTab,
  format: IssueExportFormat,
  exportedAt = new Date(),
): IssueExportFile {
  const tabInfo = tabLabels[tab];
  const suggestedName = `log-morning_${filenameDate(group)}_${tabInfo.code}_${group.count}events.${format}`;
  return {
    extension: format,
    suggestedName,
    contents: format === "json" ? buildJson(group, tab, exportedAt) : buildText(group, tab, exportedAt),
  };
}
