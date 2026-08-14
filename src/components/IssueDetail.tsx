import {
  Braces,
  Check,
  Clock3,
  Copy,
  Database,
  Download,
  FileText,
  FolderOpen,
  LoaderCircle,
  Server,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isDesktopRuntime, revealIssueExport, saveIssueExport } from "../lib/dataService";
import { buildIssueExport, type IssueExportFormat } from "../lib/issueExport";
import { formatJsonMessage } from "../lib/jsonFormat";
import { normalizeLogFontSize, type LogFontSize } from "../lib/logFontSize";
import type { IssueGroup, LogEvent, LogTab } from "../types";

interface IssueDetailProps {
  group?: IssueGroup;
  tab: LogTab;
}

const tabInfo: Record<LogTab, { label: string; className: string }> = {
  all: { label: "전체", className: "all" },
  errors: { label: "ERROR", className: "error" },
  warnings: { label: "WARN", className: "warn" },
  businessFailures: { label: "업무실패", className: "business" },
};

const LOG_FONT_SIZE_KEY = "log-morning.log-font-size";
const logFontSizeOptions: { label: string; value: LogFontSize }[] = [
  { label: "작게", value: "small" },
  { label: "보통", value: "medium" },
  { label: "크게", value: "large" },
];

function savedLogFontSize(): LogFontSize {
  try {
    return normalizeLogFontSize(window.localStorage.getItem(LOG_FONT_SIZE_KEY));
  } catch {
    return normalizeLogFontSize(null);
  }
}

function displayTimestamp(timestamp: string): string {
  if (!timestamp) return "-";
  const [date, time] = timestamp.split("T");
  return `${date} ${time?.slice(0, 8) ?? ""}`;
}

function ActivityChart({ counts }: { counts: number[] }) {
  const max = Math.max(...counts, 1);
  return (
    <div className="activity-chart" aria-label="시간별 발생량">
      <div className="chart-bars">
        {counts.map((count, hour) => (
          <div className="chart-column" key={hour} title={`${hour}시 · ${count}건`}>
            <span className={count ? "has-value" : ""} style={{ height: `${Math.max((count / max) * 100, count ? 8 : 2)}%` }} />
          </div>
        ))}
      </div>
      <div className="chart-axis">
        <span>06시</span>
        <span>12시</span>
        <span>18시</span>
        <span>00시</span>
        <span>06시</span>
      </div>
    </div>
  );
}

function EventItem({ event, fontSize, index }: { event: LogEvent; fontSize: LogFontSize; index: number }) {
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const formattedMessage = useMemo(() => formatJsonMessage(event.message), [event.message]);
  const displayedMessage = formattedMessage && !showRaw ? formattedMessage : event.message;

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(event.message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details className="event-item" open={index === 0}>
      <summary>
        <span className="event-index">#{String(index + 1).padStart(2, "0")}</span>
        <span className="event-time">{displayTimestamp(event.timestamp)}</span>
        <span className="event-source">{event.logGroup}</span>
        <span className="event-expand">로그 보기</span>
      </summary>
      <div className="event-message-wrap">
        <div className="event-message-toolbar">
          {formattedMessage && (
            <span className="json-badge">
              <Braces size={12} />
              JSON
            </span>
          )}
          {formattedMessage && (
            <button
              type="button"
              className="message-view-button"
              aria-pressed={!showRaw}
              onClick={() => setShowRaw((current) => !current)}
            >
              {showRaw ? "정렬 보기" : "원문 보기"}
            </button>
          )}
          <button type="button" onClick={copyMessage} className="copy-button">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "복사됨" : "복사"}
          </button>
        </div>
        <pre className={`${formattedMessage && !showRaw ? "is-json " : ""}log-font-${fontSize}`}>
          {displayedMessage}
        </pre>
        <div className="event-footnote">
          <span>stream: {event.logStream ?? "-"}</span>
          <span>event: {event.eventId ?? "-"}</span>
        </div>
      </div>
    </details>
  );
}

export function IssueDetail({ group, tab }: IssueDetailProps) {
  const info = tabInfo[tab];
  const [logFontSize, setLogFontSize] = useState<LogFontSize>(savedLogFontSize);
  const [exportingFormat, setExportingFormat] = useState<IssueExportFormat | null>(null);
  const [openingExportPath, setOpeningExportPath] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<{
    tone: "success" | "error";
    text: string;
    path?: string;
  } | null>(null);
  const visibleEvents = useMemo(() => group?.events.slice(0, 30) ?? [], [group]);

  useEffect(() => {
    setExportFeedback(null);
    setExportingFormat(null);
    setOpeningExportPath(false);
  }, [group?.id]);

  function selectLogFontSize(value: LogFontSize) {
    setLogFontSize(value);
    try {
      window.localStorage.setItem(LOG_FONT_SIZE_KEY, value);
    } catch {
      // 저장할 수 없는 환경에서도 이번 실행 중의 글자 크기 변경은 유지한다.
    }
  }

  async function exportAllEvents(format: IssueExportFormat) {
    if (!group || exportingFormat) return;
    setExportFeedback(null);
    setExportingFormat(format);
    try {
      const file = buildIssueExport(group, tab, format);
      const result = await saveIssueExport(file.suggestedName, file.extension, file.contents);
      if (result.saved) {
        const savedName = result.path?.split(/[\\/]/).at(-1) ?? file.suggestedName;
        setExportFeedback({
          tone: "success",
          text: `${savedName} 저장 완료`,
          path: isDesktopRuntime ? (result.path ?? undefined) : undefined,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setExportFeedback({ tone: "error", text: message || "파일을 저장하지 못했습니다." });
    } finally {
      setExportingFormat(null);
    }
  }

  async function revealSavedExport() {
    if (!exportFeedback?.path || openingExportPath) return;
    setOpeningExportPath(true);
    try {
      await revealIssueExport(exportFeedback.path);
    } catch {
      setExportFeedback({
        tone: "error",
        text: "저장 위치를 열지 못했습니다. 파일이 이동되거나 삭제됐는지 확인해주세요.",
      });
    } finally {
      setOpeningExportPath(false);
    }
  }

  if (!group) {
    return (
      <div className="detail-empty">
        <TerminalSquare size={28} />
        <strong>왼쪽에서 로그 유형을 선택하세요</strong>
        <p>발생 시각과 실제 로그 원문을 자세히 볼 수 있어요.</p>
      </div>
    );
  }

  return (
    <article className="issue-detail">
      <header className="detail-header">
        <div className="detail-header-top">
          <div className="detail-badges">
            <span className={`severity-badge ${info.className}`}>{info.label}</span>
            <span className="count-badge">{group.count.toLocaleString()}건 발생</span>
          </div>
          <div className="detail-export-panel">
            <div className="detail-export-actions" role="group" aria-label="AI 분석용 전체 로그 내보내기">
              <span className="detail-export-label">
                <Download size={13} />
                전체 내보내기
              </span>
              {(["txt", "json"] as const).map((format) => (
                <button
                  type="button"
                  key={format}
                  disabled={exportingFormat !== null}
                  onClick={() => exportAllEvents(format)}
                >
                  {exportingFormat === format ? (
                    <LoaderCircle className="is-spinning" size={12} />
                  ) : format === "json" ? (
                    <Braces size={12} />
                  ) : (
                    <FileText size={12} />
                  )}
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
            <span className="detail-export-privacy">전체 원문 포함 · 외부 AI 업로드 전 개인정보 확인</span>
          </div>
        </div>
        <h3>{group.title}</h3>
        <div className="detail-meta">
          <span>
            <Clock3 size={14} />
            {displayTimestamp(group.firstSeen)} ~ {displayTimestamp(group.lastSeen)}
          </span>
          <span>
            <Server size={14} />
            {group.logGroups.length}개 로그 그룹
          </span>
        </div>
        {exportFeedback && (
          <div className={`detail-export-feedback is-${exportFeedback.tone}`} role="status">
            <span>
              {exportFeedback.tone === "success" && <Check size={13} />}
              {exportFeedback.text}
            </span>
            {exportFeedback.path && (
              <button
                type="button"
                className="detail-reveal-button"
                disabled={openingExportPath}
                onClick={revealSavedExport}
              >
                {openingExportPath ? (
                  <LoaderCircle className="is-spinning" size={12} />
                ) : (
                  <FolderOpen size={12} />
                )}
                폴더에서 보기
              </button>
            )}
          </div>
        )}
      </header>

      <section className="detail-section">
        <div className="detail-section-title">
          <div>
            <strong>언제 많이 발생했나요?</strong>
            <span>한국 표준시 기준 시간별 발생량</span>
          </div>
          <span className="peak-label">총 {group.count.toLocaleString()}회</span>
        </div>
        <ActivityChart counts={group.hourCounts} />
      </section>

      <section className="detail-section sources-section">
        <div className="detail-section-title compact">
          <div>
            <strong>발생 위치</strong>
            <span>이 유형이 기록된 CloudWatch 로그 그룹</span>
          </div>
        </div>
        <div className="source-chips">
          {group.logGroups.map((logGroup) => (
            <span key={logGroup}>
              <Database size={13} />
              {logGroup}
            </span>
          ))}
        </div>
      </section>

      <section className="detail-section log-section">
        <div className="detail-section-title compact log-section-title">
          <div>
            <strong>실제 로그</strong>
            <span>화면은 최근 30건 · 내보내기는 전체 {group.count.toLocaleString()}건</span>
          </div>
          <div className="log-font-control" role="group" aria-label="실제 로그 글자 크기">
            <span>글자 크기</span>
            {logFontSizeOptions.map((option) => (
              <button
                type="button"
                className={logFontSize === option.value ? "is-active" : ""}
                aria-pressed={logFontSize === option.value}
                key={option.value}
                onClick={() => selectLogFontSize(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="event-list">
          {visibleEvents.map((event, index) => (
            <EventItem
              event={event}
              fontSize={logFontSize}
              index={index}
              key={event.eventId ?? `${event.timestampMs}-${index}`}
            />
          ))}
        </div>
      </section>
    </article>
  );
}
