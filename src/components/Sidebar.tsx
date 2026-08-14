import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Cloud,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  ShieldCheck,
  Sunrise,
} from "lucide-react";
import type { BackupDaySummary, ConnectionStatus } from "../types";
import { isDesktopRuntime } from "../lib/dataService";

interface SidebarProps {
  days: BackupDaySummary[];
  selectedPrefix: string;
  connection: ConnectionStatus | null;
  loading: boolean;
  collapsed: boolean;
  onSelect: (prefix: string) => void;
  onOpenSettings: () => void;
  onToggle: () => void;
}

function shortDate(date: string): { day: string; meta: string } {
  const value = new Date(`${date}T12:00:00+09:00`);
  return {
    day: new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", timeZone: "Asia/Seoul" }).format(
      value,
    ),
    meta: new Intl.DateTimeFormat("ko-KR", { weekday: "long", timeZone: "Asia/Seoul" }).format(value),
  };
}

export function Sidebar({
  days,
  selectedPrefix,
  connection,
  loading,
  collapsed,
  onSelect,
  onOpenSettings,
  onToggle,
}: SidebarProps) {
  return (
    <aside
      className={`sidebar ${collapsed ? "is-collapsed" : ""}`}
      id="log-morning-sidebar"
      aria-label="로그 모닝 사이드바"
    >
      <button
        className="sidebar-collapse-button"
        type="button"
        onClick={onToggle}
        aria-controls="log-morning-sidebar"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
        title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>

      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <Sunrise size={24} strokeWidth={2.4} />
        </div>
        <div className="brand-copy">
          <strong>로그 모닝</strong>
          <span>Backend morning check</span>
        </div>
      </div>

      <div
        className={`connection-card sidebar-tooltip ${connection?.connected ? "is-connected" : ""}`}
        data-tooltip={
          connection?.connected
            ? `${connection.profile ?? "default"} profile · AWS 연결됨`
            : "AWS 연결 확인 중"
        }
      >
        <div className="connection-icon">
          {connection?.connected ? <Cloud size={18} /> : <ShieldCheck size={18} />}
        </div>
        <div>
          <span className="connection-label">
            {connection?.connected ? (isDesktopRuntime ? "AWS 연결됨" : "디자인 미리보기") : "AWS 연결 확인 중"}
          </span>
          <strong>{connection?.profile ?? "default"} profile</strong>
        </div>
        {connection?.connected && <CheckCircle2 className="connection-check" size={17} />}
      </div>

      <div className="sidebar-section-heading">
        <span>백업 기록</span>
        <CalendarDays size={15} />
      </div>

      <nav className="day-list" aria-label="백업 날짜">
        {loading && days.length === 0
          ? Array.from({ length: 3 }, (_, index) => <div className="day-skeleton" key={index} />)
          : days.map((day, index) => {
              const label = shortDate(day.date);
              const selected = selectedPrefix === day.prefix;
              return (
                <button
                  className={`day-item ${selected ? "is-selected" : ""}`}
                  key={day.prefix}
                  onClick={() => onSelect(day.prefix)}
                  type="button"
                  aria-label={`${label.day} ${label.meta}, 로그 ${day.total.toLocaleString()}건${index === 0 ? ", 최신" : ""}`}
                  data-tooltip={`${label.day} ${label.meta} · 로그 ${day.total.toLocaleString()}건`}
                  title={collapsed ? `${label.day} ${label.meta} · 로그 ${day.total.toLocaleString()}건` : undefined}
                >
                  <span className="day-status">
                    <span className="success-dot" />
                  </span>
                  <span className="day-copy">
                    <span className="day-title">
                      {label.day}
                      {day.status === "in_progress" ? (
                        <em className="is-live">실시간</em>
                      ) : (
                        index === 0 && <em>최신</em>
                      )}
                    </span>
                    <span className="day-meta">{label.meta} · 로그 {day.total.toLocaleString()}건</span>
                  </span>
                  <ChevronRight size={16} />
                  <span className="day-compact-icon" aria-hidden="true">
                    <CalendarDays size={20} />
                    <b>{Number(day.date.slice(-2))}</b>
                  </span>
                </button>
              );
            })}
      </nav>

      <div className="sidebar-spacer" />

      <div className="privacy-note sidebar-tooltip" data-tooltip="로그는 이 PC에서만 열립니다">
        <ShieldCheck size={17} />
        <p>
          로그는 이 PC에서만 열립니다.
          <span>별도 서버로 전송하지 않아요.</span>
        </p>
      </div>

      <button
        className="settings-button sidebar-tooltip"
        type="button"
        onClick={onOpenSettings}
        aria-label="연결 설정 열기"
        data-tooltip="연결 설정"
      >
        <Settings2 size={18} />
        <span>
          연결 설정
          <small>프로필 · 보안 정보</small>
        </span>
        <ChevronRight size={16} />
      </button>
    </aside>
  );
}
