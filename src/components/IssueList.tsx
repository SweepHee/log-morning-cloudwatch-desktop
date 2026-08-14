import { ChevronRight, Inbox, Layers3 } from "lucide-react";
import { issueToneFor } from "../lib/issueTone";
import type { IssueGroup, LogTab } from "../types";

interface IssueListProps {
  groups: IssueGroup[];
  selectedId?: string;
  tab: LogTab;
  onSelect: (id: string) => void;
}

const tabLabels: Record<LogTab, string> = {
  all: "전체",
  errors: "에러",
  warnings: "워닝",
  businessFailures: "업무실패",
};

function displayTime(timestamp: string): string {
  const match = timestamp.match(/T(\d{2}:\d{2})/);
  return match?.[1] ?? "-";
}

function sourceName(logGroup: string): string {
  return logGroup
    .replace("/ecs/", "")
    .replace(/-log-group$/, "")
    .replace(/^production-/, "prod · ")
    .replace(/^dev-/, "dev · ");
}

export function IssueList({ groups, selectedId, tab, onSelect }: IssueListProps) {
  if (groups.length === 0) {
    return (
      <div className="issue-empty">
        <span>
          <Inbox size={25} />
        </span>
        <strong>조건에 맞는 로그가 없어요</strong>
        <p>검색어를 지우거나 다른 항목을 확인해보세요.</p>
      </div>
    );
  }

  return (
    <div className="issue-list">
      <div className="list-summary">
        <Layers3 size={15} />
        <span>
          {tabLabels[tab]} 로그를 <strong>{groups.length}개 유형</strong>으로 정리했어요
        </span>
      </div>
      {groups.map((group, index) => {
        const tone = issueToneFor(group, tab);
        return (
          <button
            type="button"
            className={`issue-row issue-tone-${tone} ${selectedId === group.id ? "is-selected" : ""}`}
            key={group.id}
            onClick={() => onSelect(group.id)}
          >
            <span className="issue-rank">{String(index + 1).padStart(2, "0")}</span>
            <span className="issue-row-main">
              <span className="issue-row-top">
                <strong>{group.title}</strong>
                <em>{group.count.toLocaleString()}건</em>
              </span>
              <span className="issue-row-bottom">
                <span>{sourceName(group.logGroups[0] ?? "알 수 없음")}</span>
                {group.logGroups.length > 1 && <span>외 {group.logGroups.length - 1}</span>}
                <i />
                <span>마지막 {displayTime(group.lastSeen)}</span>
              </span>
            </span>
            <ChevronRight className="issue-chevron" size={17} />
          </button>
        );
      })}
    </div>
  );
}
