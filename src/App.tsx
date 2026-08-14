import {
  AlertOctagon,
  BriefcaseBusiness,
  CheckCircle2,
  Database,
  FileStack,
  ListFilter,
  LoaderCircle,
  RefreshCw,
  Radio,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IssueDetail } from "./components/IssueDetail";
import { IssueList } from "./components/IssueList";
import { MetricCard } from "./components/MetricCard";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import {
  checkConnection,
  isDesktopRuntime,
  listBackupDays,
  loadBackupDay,
  refreshCurrentBackup,
} from "./lib/dataService";
import {
  hasMinimumBackupSettings,
  loadAwsSettings,
  saveAwsSettings,
} from "./lib/awsSettings";
import { groupEvents, matchesSearch } from "./lib/groupLogs";
import {
  environmentForLogGroup,
  filterLogEvents,
  type EnvironmentFilter,
} from "./lib/logFilters";
import {
  normalizeSidebarCollapsed,
  SIDEBAR_COLLAPSED_KEY,
} from "./lib/sidebarState";
import type { AwsSettings, BackupDaySummary, ConnectionStatus, DayLogData, LogTab } from "./types";

function friendlyDate(date: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Seoul",
  }).format(new Date(`${date}T12:00:00+09:00`));
}

function windowTime(summary?: BackupDaySummary): string {
  if (!summary) return "";
  const start = summary.windowStartKst.match(/T(\d{2}:\d{2})/)?.[1] ?? "06:00";
  const end = summary.windowEndKst.match(/T(\d{2}:\d{2})/)?.[1] ?? "06:00";
  if (summary.status === "in_progress") {
    return `${summary.date} ${start}부터 ${end}까지 수집`;
  }
  return `${summary.date} ${start}부터 다음 날 ${end}까지`;
}

function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Asia/Seoul",
    }).format(new Date()),
  );
  if (hour < 11) return "좋은 아침이에요";
  if (hour < 18) return "오늘 로그를 살펴볼까요";
  return "하루 로그를 정리해볼까요";
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}

export default function App() {
  const [settings, setSettings] = useState<AwsSettings>(() => loadAwsSettings());
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [days, setDays] = useState<BackupDaySummary[]>([]);
  const [selectedPrefix, setSelectedPrefix] = useState("");
  const [dayData, setDayData] = useState<DayLogData | null>(null);
  const [activeTab, setActiveTab] = useState<LogTab>("errors");
  const [search, setSearch] = useState("");
  const [environment, setEnvironment] = useState<EnvironmentFilter>("all");
  const [logGroup, setLogGroup] = useState("");
  const [logStream, setLogStream] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(() => !hasMinimumBackupSettings(loadAwsSettings()));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return normalizeSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY));
    } catch {
      return false;
    }
  });
  const [loadingDays, setLoadingDays] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingCurrent, setRefreshingCurrent] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState("");

  const refreshDays = useCallback(async () => {
    if (!hasMinimumBackupSettings(settings)) {
      setConnection(null);
      setDays([]);
      setSelectedPrefix("");
      setLoadingDays(false);
      setSettingsOpen(true);
      return;
    }
    setRefreshing(true);
    setLoadingDays(true);
    setError("");
    try {
      const [nextConnection, nextDays] = await Promise.all([
        checkConnection(settings),
        listBackupDays(settings),
      ]);
      setConnection(nextConnection);
      setDays(nextDays);
      setReloadToken((current) => current + 1);
      setSelectedPrefix((current) => {
        if (nextDays.some((day) => day.prefix === current)) return current;
        return nextDays[0]?.prefix ?? "";
      });
    } catch (nextError) {
      setConnection(null);
      setError(errorMessage(nextError));
    } finally {
      setRefreshing(false);
      setLoadingDays(false);
    }
  }, [settings]);

  useEffect(() => {
    void refreshDays();
  }, [refreshDays]);

  useEffect(() => {
    if (!selectedPrefix) {
      setDayData(null);
      return;
    }

    let cancelled = false;
    setLoadingLogs(true);
    setError("");
    void loadBackupDay(settings, selectedPrefix)
      .then((data) => {
        if (!cancelled) setDayData(data);
      })
      .catch((nextError) => {
        if (!cancelled) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoadingLogs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settings, selectedPrefix, reloadToken]);

  const selectedSummary =
    dayData?.summary ?? days.find((day) => day.prefix === selectedPrefix) ?? days[0];
  const activeEvents = dayData?.[activeTab] ?? [];
  const environmentCounts = useMemo(
    () =>
      activeEvents.reduce(
        (counts, event) => {
          counts[environmentForLogGroup(event.logGroup)] += 1;
          return counts;
        },
        { prod: 0, dev: 0, unknown: 0 },
      ),
    [activeEvents],
  );
  const logGroupOptions = useMemo(
    () =>
      Array.from(
        new Set(
          activeEvents
            .filter(
              (event) =>
                environment === "all" ||
                environmentForLogGroup(event.logGroup) === environment,
            )
            .map((event) => event.logGroup),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [activeEvents, environment],
  );
  const logStreamOptions = useMemo(
    () =>
      Array.from(
        new Set(
          activeEvents
            .filter(
              (event) =>
                (environment === "all" ||
                  environmentForLogGroup(event.logGroup) === environment) &&
                (!logGroup || event.logGroup === logGroup),
            )
            .map((event) => event.logStream)
            .filter((stream): stream is string => Boolean(stream)),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [activeEvents, environment, logGroup],
  );
  const filteredEvents = useMemo(
    () => filterLogEvents(activeEvents, { environment, logGroup, logStream }),
    [activeEvents, environment, logGroup, logStream],
  );
  const allGroups = useMemo(() => groupEvents(filteredEvents), [filteredEvents]);
  const visibleGroups = useMemo(
    () => allGroups.filter((group) => matchesSearch(group, search)),
    [allGroups, search],
  );

  useEffect(() => {
    if (logGroup && !logGroupOptions.includes(logGroup)) {
      setLogGroup("");
      setLogStream("");
    }
  }, [logGroup, logGroupOptions]);

  useEffect(() => {
    if (logStream && !logStreamOptions.includes(logStream)) setLogStream("");
  }, [logStream, logStreamOptions]);

  useEffect(() => {
    setSelectedGroupId((current) =>
      current && visibleGroups.some((group) => group.id === current)
        ? current
        : visibleGroups[0]?.id,
    );
  }, [visibleGroups]);

  const selectedGroup = visibleGroups.find((group) => group.id === selectedGroupId);
  const metricCounts = {
    all: selectedSummary?.total ?? 0,
    errors: selectedSummary?.error ?? 0,
    warnings: selectedSummary?.warn ?? 0,
    businessFailures: selectedSummary?.businessFailure ?? 0,
  };
  const filterCount = Number(environment !== "all") + Number(Boolean(logGroup)) + Number(Boolean(logStream));

  function selectEnvironment(nextEnvironment: EnvironmentFilter) {
    setEnvironment(nextEnvironment);
    setLogGroup("");
    setLogStream("");
  }

  function selectLogGroup(nextLogGroup: string) {
    setLogGroup(nextLogGroup);
    setLogStream("");
  }

  function resetFilters() {
    setEnvironment("all");
    setLogGroup("");
    setLogStream("");
  }

  async function updateCurrentLogs() {
    setRefreshingCurrent(true);
    setError("");
    try {
      const result = await refreshCurrentBackup(settings);
      await refreshDays();
      setSelectedPrefix(result.prefix);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setRefreshingCurrent(false);
    }
  }

  function saveSettings(nextSettings: AwsSettings) {
    const saved = saveAwsSettings(nextSettings);
    setSettings(saved);
    setSettingsOpen(false);
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        // 로컬 저장소를 사용할 수 없는 환경에서는 현재 실행 중인 상태만 유지한다.
      }
      return next;
    });
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
      <Sidebar
        days={days}
        selectedPrefix={selectedPrefix}
        connection={connection}
        loading={loadingDays}
        collapsed={sidebarCollapsed}
        onSelect={setSelectedPrefix}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggle={toggleSidebar}
      />

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>CloudWatch Daily</span>
            <i />
            <strong>{selectedSummary ? friendlyDate(selectedSummary.date) : "백업 불러오는 중"}</strong>
          </div>
          <div className="topbar-actions">
            {!isDesktopRuntime && (
              <span className="preview-pill">
                <Sparkles size={14} />
                미리보기 데이터
              </span>
            )}
            <button
              className="current-log-button"
              type="button"
              disabled={refreshingCurrent || refreshing || !connection?.connected}
              onClick={() => void updateCurrentLogs()}
            >
              {refreshingCurrent ? (
                <RefreshCw className="is-spinning" size={15} />
              ) : (
                <Radio size={15} />
              )}
              {refreshingCurrent ? "오늘 로그 만드는 중" : "오늘 최신 로그"}
            </button>
            <span className="secure-pill">
              <Database size={14} />
              S3 직접 연결
            </span>
            <button
              className="refresh-button"
              type="button"
              disabled={refreshing}
              onClick={() => void refreshDays()}
            >
              <RefreshCw className={refreshing ? "is-spinning" : ""} size={16} />
              새로고침
            </button>
          </div>
        </header>

        <div className="content-scroll">
          {error && (
            <div className="error-banner">
              <WifiOff size={19} />
              <div>
                <strong>로그를 불러오지 못했어요</strong>
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => setSettingsOpen(true)}>
                연결 설정
              </button>
            </div>
          )}

          <section className="morning-hero">
            <div className="hero-copy">
              <span className="hero-kicker">
                <span />
                BACKEND MORNING CHECK
              </span>
              <h1>{greeting()}.</h1>
              <p>
                밤사이 쌓인 백엔드 로그를 유형별로 정리했어요.
                <br />
                중요한 것부터 천천히 확인해보세요.
              </p>
              <div className={`window-label ${selectedSummary?.status === "in_progress" ? "is-live" : ""}`}>
                {selectedSummary?.status === "in_progress" ? (
                  <Radio size={16} />
                ) : (
                  <CheckCircle2 size={16} />
                )}
                <span>
                  {selectedSummary?.status === "in_progress" ? "오늘 최신 로그" : "백업 완료"}
                  <small>{windowTime(selectedSummary)}</small>
                </span>
              </div>
            </div>
            <div className="hero-visual" aria-hidden="true">
              <div className="sun-orbit orbit-one" />
              <div className="sun-orbit orbit-two" />
              <div className="hero-sun" />
              <div className="hero-hills hill-back" />
              <div className="hero-hills hill-front" />
              <div className="floating-log log-one">
                <span />
                <span />
                <span />
              </div>
              <div className="floating-log log-two">
                <span />
                <span />
              </div>
            </div>
          </section>

          <section className="metrics-grid" aria-label="로그 요약">
            <MetricCard
              label="전체 로그"
              value={metricCounts.all}
              description="모든 원본 로그를 살펴봐요"
              icon={FileStack}
              tone="neutral"
              active={activeTab === "all"}
              onClick={() => setActiveTab("all")}
            />
            <MetricCard
              label="에러 로그"
              value={metricCounts.errors}
              description="우선 확인이 필요해요"
              icon={AlertOctagon}
              tone="error"
              active={activeTab === "errors"}
              onClick={() => setActiveTab("errors")}
            />
            <MetricCard
              label="워닝 로그"
              value={metricCounts.warnings}
              description="이상 징후를 확인해요"
              icon={TriangleAlert}
              tone="warn"
              active={activeTab === "warnings"}
              onClick={() => setActiveTab("warnings")}
            />
            <MetricCard
              label="업무 실패"
              value={metricCounts.businessFailures}
              description="INFO 속 실패도 분리했어요"
              icon={BriefcaseBusiness}
              tone="business"
              active={activeTab === "businessFailures"}
              onClick={() => setActiveTab("businessFailures")}
            />
          </section>

          <section className="issues-section">
            <header className="issues-header">
              <div>
                <span className="section-eyebrow">MORNING REVIEW</span>
                <h2>오늘 살펴볼 로그</h2>
                <p>같은 원인의 로그는 한 묶음으로 정리됩니다.</p>
              </div>
              <div className="issues-tools">
                <div className="tab-group" role="tablist" aria-label="로그 종류">
                  <button
                    type="button"
                    className={activeTab === "all" ? "is-active tab-all" : ""}
                    onClick={() => setActiveTab("all")}
                  >
                    전체 <span>{metricCounts.all.toLocaleString()}</span>
                  </button>
                  <button
                    type="button"
                    className={activeTab === "errors" ? "is-active tab-error" : ""}
                    onClick={() => setActiveTab("errors")}
                  >
                    ERROR <span>{metricCounts.errors.toLocaleString()}</span>
                  </button>
                  <button
                    type="button"
                    className={activeTab === "warnings" ? "is-active tab-warn" : ""}
                    onClick={() => setActiveTab("warnings")}
                  >
                    WARN <span>{metricCounts.warnings.toLocaleString()}</span>
                  </button>
                  <button
                    type="button"
                    className={activeTab === "businessFailures" ? "is-active tab-business" : ""}
                    onClick={() => setActiveTab("businessFailures")}
                  >
                    업무실패 <span>{metricCounts.businessFailures.toLocaleString()}</span>
                  </button>
                </div>
                <label className="search-field">
                  <Search size={16} />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="메시지나 로그 그룹 검색"
                  />
                </label>
              </div>
            </header>

            <div className="filter-panel" aria-label="로그 세부 필터">
              <div className="filter-heading">
                <ListFilter size={16} />
                <span>세부 필터</span>
              </div>
              <div className="environment-filter" role="group" aria-label="환경">
                <button
                  type="button"
                  className={environment === "all" ? "is-active" : ""}
                  onClick={() => selectEnvironment("all")}
                >
                  전체 <span>{activeEvents.length.toLocaleString()}</span>
                </button>
                <button
                  type="button"
                  className={environment === "prod" ? "is-active env-prod" : ""}
                  onClick={() => selectEnvironment("prod")}
                >
                  PROD <span>{environmentCounts.prod.toLocaleString()}</span>
                </button>
                <button
                  type="button"
                  className={environment === "dev" ? "is-active env-dev" : ""}
                  onClick={() => selectEnvironment("dev")}
                >
                  DEV <span>{environmentCounts.dev.toLocaleString()}</span>
                </button>
                <button
                  type="button"
                  className={environment === "unknown" ? "is-active env-unknown" : ""}
                  onClick={() => selectEnvironment("unknown")}
                >
                  미분류 <span>{environmentCounts.unknown.toLocaleString()}</span>
                </button>
              </div>
              <label className="filter-select">
                <span>로그 그룹</span>
                <select value={logGroup} onChange={(event) => selectLogGroup(event.target.value)}>
                  <option value="">전체 로그 그룹</option>
                  {logGroupOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-select stream-select">
                <span>스트림</span>
                <select value={logStream} onChange={(event) => setLogStream(event.target.value)}>
                  <option value="">전체 스트림</option>
                  {logStreamOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="filter-reset"
                disabled={filterCount === 0}
                onClick={resetFilters}
                title="환경·로그 그룹·스트림 필터 초기화"
              >
                <RotateCcw size={14} />
                초기화
              </button>
              <span className="filter-result">
                <strong>{filteredEvents.length.toLocaleString()}</strong>건 · {visibleGroups.length.toLocaleString()}개 유형
              </span>
            </div>

            <div className="issue-workspace">
              {loadingLogs ? (
                <div className="workspace-loading">
                  <LoaderCircle className="is-spinning" size={25} />
                  <strong>S3 백업을 정리하고 있어요</strong>
                  <span>압축된 필터 파일만 안전하게 읽는 중입니다.</span>
                </div>
              ) : !dayData ? (
                <div className="workspace-loading">
                  <ShieldAlert size={25} />
                  <strong>표시할 백업이 없어요</strong>
                  <span>연결 설정과 _SUCCESS 파일을 확인해주세요.</span>
                </div>
              ) : (
                <>
                  <div className="issue-pane">
                    <IssueList
                      groups={visibleGroups}
                      selectedId={selectedGroupId}
                      tab={activeTab}
                      onSelect={setSelectedGroupId}
                    />
                  </div>
                  <div className="detail-pane">
                    <IssueDetail group={selectedGroup} tab={activeTab} />
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      </main>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={saveSettings}
      />
    </div>
  );
}
