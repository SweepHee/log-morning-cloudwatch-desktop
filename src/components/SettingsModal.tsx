import {
  CheckCircle2,
  Cloud,
  CloudCog,
  Database,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  checkConnection,
  deleteAccessKey,
  getCredentialStatus,
  getBackupInfrastructureStatus,
  installBackupInfrastructure,
  listCloudWatchLogGroups,
  listCloudWatchLogStreams,
  listS3Buckets,
  saveAccessKey,
  saveIssueExport,
} from "../lib/dataService";
import { backupSourcesJson } from "../lib/backupSources";
import type {
  AccessKeyInput,
  AwsAuthMode,
  AwsSettings,
  BackupInfrastructureStatus,
  CloudWatchLogGroupSummary,
  CloudWatchLogStreamSummary,
  CredentialStatus,
  S3BucketSummary,
} from "../types";

interface SettingsModalProps {
  open: boolean;
  settings: AwsSettings;
  onClose: () => void;
  onSave: (settings: AwsSettings) => void;
}

const EMPTY_ACCESS_KEY: AccessKeyInput = {
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
};

const AUTH_OPTIONS: Array<{
  mode: AwsAuthMode;
  title: string;
  description: string;
  recommended?: boolean;
}> = [
  {
    mode: "auto",
    title: "자동 연결",
    description: "환경변수, 기본 Profile, Role 등 이 PC의 기존 AWS 설정을 자동으로 찾습니다.",
    recommended: true,
  },
  {
    mode: "profile",
    title: "Profile · SSO",
    description: "회사 SSO 또는 이름이 있는 AWS CLI Profile을 사용합니다.",
  },
  {
    mode: "accessKey",
    title: "Access Key",
    description: "키는 설정 파일이 아닌 운영체제 보안 저장소에만 보관합니다.",
  },
];

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

export function SettingsModal({ open, settings, onClose, onSave }: SettingsModalProps) {
  const [draft, setDraft] = useState<AwsSettings>(settings);
  const [accessKey, setAccessKey] = useState<AccessKeyInput>(EMPTY_ACCESS_KEY);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>({
    stored: false,
    accessKeyHint: "",
  });
  const [buckets, setBuckets] = useState<S3BucketSummary[]>([]);
  const [logGroups, setLogGroups] = useState<CloudWatchLogGroupSummary[]>([]);
  const [streamsByGroup, setStreamsByGroup] = useState<
    Record<string, CloudWatchLogStreamSummary[]>
  >({});
  const [groupSearch, setGroupSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [infrastructureStatus, setInfrastructureStatus] =
    useState<BackupInfrastructureStatus | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft({
      ...settings,
      logGroups: [...settings.logGroups],
      logStreams: Object.fromEntries(
        Object.entries(settings.logStreams).map(([group, streams]) => [group, [...streams]]),
      ),
    });
    setAccessKey(EMPTY_ACCESS_KEY);
    setBuckets([]);
    setLogGroups([]);
    setStreamsByGroup({});
    setGroupSearch("");
    setNotice("");
    setError("");
    setInfrastructureStatus(null);
    void getCredentialStatus()
      .then(setCredentialStatus)
      .catch((nextError) => setError(errorMessage(nextError)));
  }, [open, settings]);

  const visibleGroups = useMemo(() => {
    const query = groupSearch.trim().toLowerCase();
    return query
      ? logGroups.filter((group) => group.name.toLowerCase().includes(query))
      : logGroups;
  }, [groupSearch, logGroups]);

  if (!open) return null;

  function update<K extends keyof AwsSettings>(key: K, value: AwsSettings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function ensureAccessKey(): Promise<void> {
    if (draft.authMode !== "accessKey") return;
    if (accessKey.accessKeyId.trim() || accessKey.secretAccessKey.trim()) {
      if (!accessKey.accessKeyId.trim() || !accessKey.secretAccessKey.trim()) {
        throw new Error("Access Key ID와 Secret Access Key를 모두 입력하세요.");
      }
      const status = await saveAccessKey(accessKey);
      setCredentialStatus(status);
      setAccessKey(EMPTY_ACCESS_KEY);
      return;
    }
    if (!credentialStatus.stored) {
      throw new Error("Access Key를 입력하거나 다른 인증 방식을 선택하세요.");
    }
  }

  async function testAwsConnection() {
    setBusy("connection");
    setError("");
    setNotice("");
    try {
      await ensureAccessKey();
      const status = await checkConnection(draft);
      setNotice(`AWS 연결 성공 · 계정 ${status.accountId || "확인됨"}`);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy("");
    }
  }

  async function discoverAwsResources() {
    setBusy("resources");
    setError("");
    setNotice("");
    try {
      await ensureAccessKey();
      const [bucketResult, groupResult] = await Promise.allSettled([
        listS3Buckets(draft),
        listCloudWatchLogGroups(draft),
      ]);
      if (bucketResult.status === "fulfilled") setBuckets(bucketResult.value);
      if (groupResult.status === "fulfilled") setLogGroups(groupResult.value);
      const failures = [bucketResult, groupResult].filter((result) => result.status === "rejected");
      if (failures.length === 2) {
        throw failures[0].reason;
      }
      if (failures.length === 1) {
        setNotice("일부 목록만 가져왔습니다. IAM 목록 조회 권한을 확인하세요.");
      } else {
        setNotice("S3 버킷과 CloudWatch 로그 그룹을 가져왔습니다.");
      }
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy("");
    }
  }

  function toggleLogGroup(name: string) {
    setDraft((current) => {
      const selected = current.logGroups.includes(name);
      const logGroups = selected
        ? current.logGroups.filter((group) => group !== name)
        : [...current.logGroups, name];
      const logStreams = { ...current.logStreams };
      if (selected) delete logStreams[name];
      return { ...current, logGroups, logStreams };
    });
  }

  async function loadStreams(group: string) {
    setBusy(`streams:${group}`);
    setError("");
    try {
      await ensureAccessKey();
      const streams = await listCloudWatchLogStreams(draft, group);
      setStreamsByGroup((current) => ({ ...current, [group]: streams }));
      if (streams.length === 0) setNotice("이 로그 그룹에서 조회되는 스트림이 없습니다.");
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy("");
    }
  }

  function toggleLogStream(group: string, stream: string) {
    setDraft((current) => {
      const selected = current.logStreams[group] ?? [];
      const next = selected.includes(stream)
        ? selected.filter((name) => name !== stream)
        : [...selected, stream];
      return {
        ...current,
        logStreams: { ...current.logStreams, [group]: next },
      };
    });
  }

  async function removeStoredAccessKey() {
    setBusy("delete-key");
    setError("");
    try {
      setCredentialStatus(await deleteAccessKey());
      setNotice("운영체제 보안 저장소에서 Access Key를 삭제했습니다.");
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy("");
    }
  }

  function normalizedDraft(): AwsSettings {
    return {
      ...draft,
      profile: draft.profile.trim(),
      region: draft.region.trim(),
      bucket: draft.bucket.trim(),
      dailyPrefix: draft.dailyPrefix.trim(),
      lambdaFunction: draft.lambdaFunction.trim(),
    };
  }

  async function checkInfrastructureStatus() {
    setBusy("infrastructure-status");
    setError("");
    setNotice("");
    try {
      await ensureAccessKey();
      setInfrastructureStatus(await getBackupInfrastructureStatus(normalizedDraft()));
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy("");
    }
  }

  async function installInfrastructure() {
    setBusy("infrastructure-install");
    setError("");
    setNotice("AWS에 백업 Lambda와 오전 6시 스케줄을 설치하고 있습니다. 창을 닫지 마세요.");
    try {
      await ensureAccessKey();
      const nextSettings = normalizedDraft();
      const status = await installBackupInfrastructure(nextSettings);
      setInfrastructureStatus(status);
      setNotice("백업 Lambda 설치·업데이트가 완료되었습니다. 같은 버튼을 다시 눌러도 중복 생성되지 않습니다.");
      onSave(nextSettings);
    } catch (nextError) {
      setError(errorMessage(nextError));
      setNotice("");
    } finally {
      setBusy("");
    }
  }

  async function exportBackupSources() {
    setBusy("export-sources");
    setError("");
    try {
      if (draft.logGroups.length === 0) {
        throw new Error("먼저 백업할 CloudWatch 로그 그룹을 하나 이상 선택하세요.");
      }
      const result = await saveIssueExport(
        "log-sources.json",
        "json",
        backupSourcesJson(draft),
      );
      setNotice(
        result.path
          ? `배포용 로그 소스 JSON을 저장했습니다: ${result.path}`
          : "배포용 로그 소스 JSON을 저장했습니다.",
      );
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy("");
    }
  }

  async function save() {
    setBusy("save");
    setError("");
    try {
      await ensureAccessKey();
      if (!draft.region.trim()) throw new Error("AWS 리전을 입력하세요.");
      if (!draft.bucket.trim()) throw new Error("백업을 저장할 S3 버킷을 선택하세요.");
      if (draft.logGroups.length === 0) throw new Error("백업할 CloudWatch 로그 그룹을 하나 이상 선택하세요.");
      onSave(normalizedDraft());
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="settings-title"
        aria-modal="true"
        className="settings-modal settings-modal-public"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="modal-icon"><Cloud size={20} /></span>
            <div>
              <h2 id="settings-title">AWS 연결 및 백업 설정</h2>
              <p>키는 이 PC에만 보관하고 로그는 선택한 AWS 계정에서 직접 읽습니다.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="닫기"><X size={19} /></button>
        </header>

        <div className="settings-body public-settings-body">
          <section className="settings-section">
            <div className="settings-section-title">
              <div><KeyRound size={18} /><strong>1. AWS 인증 방식</strong></div>
              <span>사용자 환경에 맞게 하나만 선택</span>
            </div>
            <div className="auth-mode-grid">
              {AUTH_OPTIONS.map((option) => (
                <button
                  className={`auth-mode-card ${draft.authMode === option.mode ? "is-selected" : ""}`}
                  key={option.mode}
                  type="button"
                  onClick={() => update("authMode", option.mode)}
                >
                  <span>{option.title}{option.recommended && <em>추천</em>}</span>
                  <small>{option.description}</small>
                </button>
              ))}
            </div>

            {draft.authMode === "profile" && (
              <label className="field-label" htmlFor="aws-profile">
                AWS Profile 또는 SSO Profile 이름
                <div className="input-with-icon">
                  <KeyRound size={17} />
                  <input
                    id="aws-profile"
                    value={draft.profile}
                    onChange={(event) => update("profile", event.target.value)}
                    placeholder="예: company-prod"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
              </label>
            )}

            {draft.authMode === "accessKey" && (
              <div className="access-key-fields">
                {credentialStatus.stored && (
                  <div className="credential-saved-row">
                    <CheckCircle2 size={17} />
                    <span>보안 저장소에 키가 있습니다: {credentialStatus.accessKeyHint}</span>
                    <button type="button" onClick={() => void removeStoredAccessKey()} disabled={Boolean(busy)}>
                      <Trash2 size={14} /> 삭제
                    </button>
                  </div>
                )}
                <div className="settings-two-columns">
                  <label className="field-label">
                    Access Key ID
                    <input
                      value={accessKey.accessKeyId}
                      onChange={(event) => setAccessKey((current) => ({ ...current, accessKeyId: event.target.value }))}
                      placeholder={credentialStatus.stored ? "새 키로 교체할 때만 입력" : "AKIA..."}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field-label">
                    Secret Access Key
                    <input
                      type="password"
                      value={accessKey.secretAccessKey}
                      onChange={(event) => setAccessKey((current) => ({ ...current, secretAccessKey: event.target.value }))}
                      placeholder={credentialStatus.stored ? "새 키로 교체할 때만 입력" : "Secret Access Key"}
                      autoComplete="new-password"
                    />
                  </label>
                </div>
                <label className="field-label">
                  Session Token <span>임시 자격 증명일 때만 입력</span>
                  <textarea
                    rows={2}
                    value={accessKey.sessionToken}
                    onChange={(event) => setAccessKey((current) => ({ ...current, sessionToken: event.target.value }))}
                    placeholder="선택 사항"
                    autoComplete="off"
                  />
                </label>
              </div>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-section-title">
              <div><Database size={18} /><strong>2. AWS 리전과 S3</strong></div>
              <button className="settings-inline-action" type="button" onClick={() => void discoverAwsResources()} disabled={Boolean(busy)}>
                {busy === "resources" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                AWS 목록 불러오기
              </button>
            </div>
            <div className="settings-two-columns">
              <label className="field-label">
                AWS 리전
                <input value={draft.region} onChange={(event) => update("region", event.target.value)} placeholder="ap-northeast-2" spellCheck={false} />
              </label>
              <label className="field-label">
                백업 S3 버킷
                <input list="aws-bucket-options" value={draft.bucket} onChange={(event) => update("bucket", event.target.value)} placeholder="my-cloudwatch-backup" spellCheck={false} />
                <datalist id="aws-bucket-options">{buckets.map((bucket) => <option key={bucket.name} value={bucket.name} />)}</datalist>
              </label>
            </div>
            <div className="settings-two-columns">
              <label className="field-label">
                S3 백업 경로
                <input value={draft.dailyPrefix} onChange={(event) => update("dailyPrefix", event.target.value)} spellCheck={false} />
              </label>
              <label className="field-label">
                Lambda 함수 이름
                <input value={draft.lambdaFunction} onChange={(event) => update("lambdaFunction", event.target.value)} spellCheck={false} />
              </label>
            </div>
            <button className="connection-test-button" type="button" onClick={() => void testAwsConnection()} disabled={Boolean(busy)}>
              {busy === "connection" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
              AWS 연결 확인
            </button>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">
              <div><Cloud size={18} /><strong>3. 백업할 로그 그룹·스트림</strong></div>
              <div className="settings-section-actions">
                <span>{draft.logGroups.length}개 그룹 선택</span>
                <button
                  className="settings-inline-action"
                  type="button"
                  onClick={() => void exportBackupSources()}
                  disabled={Boolean(busy) || draft.logGroups.length === 0}
                >
                  {busy === "export-sources" ? <LoaderCircle className="spin" size={15} /> : <Database size={15} />}
                  배포용 JSON 저장
                </button>
              </div>
            </div>
            {logGroups.length === 0 ? (
              <div className="resource-empty">`AWS 목록 불러오기`를 누르면 선택 가능한 로그 그룹이 표시됩니다.</div>
            ) : (
              <>
                <input className="resource-search" value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder="로그 그룹 검색" />
                <div className="log-group-picker">
                  {visibleGroups.map((group) => {
                    const selected = draft.logGroups.includes(group.name);
                    const streams = streamsByGroup[group.name];
                    const selectedStreams = draft.logStreams[group.name] ?? [];
                    return (
                      <div className={`log-group-option ${selected ? "is-selected" : ""}`} key={group.name}>
                        <label>
                          <input type="checkbox" checked={selected} onChange={() => toggleLogGroup(group.name)} />
                          <span><strong>{group.name}</strong><small>{formatBytes(group.storedBytes)} · 보관 {group.retentionDays ?? "무기한"}일</small></span>
                        </label>
                        {selected && (
                          <div className="stream-picker">
                            <button type="button" onClick={() => void loadStreams(group.name)} disabled={Boolean(busy)}>
                              {busy === `streams:${group.name}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                              최근 스트림 보기
                            </button>
                            <small>{selectedStreams.length === 0 ? "선택하지 않으면 그룹 전체 백업" : `${selectedStreams.length}개 스트림만 백업`}</small>
                            {streams && (
                              <div className="stream-option-list">
                                {streams.map((stream) => (
                                  <label key={stream.name}>
                                    <input type="checkbox" checked={selectedStreams.includes(stream.name)} onChange={() => toggleLogStream(group.name, stream.name)} />
                                    <span>{stream.name}</span>
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-section-title">
              <div><CloudCog size={18} /><strong>4. 백업 Lambda 자동 설치</strong></div>
              <span>CloudFormation으로 한 번만 생성</span>
            </div>
            <div className="infrastructure-card">
              <div className="infrastructure-copy">
                <strong>중복 설치를 자동으로 방지합니다.</strong>
                <p>
                  계정·리전마다 <code>log-morning-cloudwatch-backup</code> 스택 하나만 사용합니다.
                  다시 누르면 새 Lambda를 만들지 않고 기존 스택의 로그 선택과 코드를 업데이트합니다.
                </p>
              </div>
              {infrastructureStatus && (
                <div className={`infrastructure-status is-${infrastructureStatus.state}`}>
                  <span>{infrastructureStatus.state === "ready" ? "설치 완료" : infrastructureStatus.state === "external" ? "기존 Lambda" : infrastructureStatus.state === "installing" ? "설치 중" : infrastructureStatus.state === "failed" ? "확인 필요" : "미설치"}</span>
                  <p>{infrastructureStatus.message}</p>
                  {infrastructureStatus.stackStatus && <small>{infrastructureStatus.stackStatus}</small>}
                </div>
              )}
              <div className="infrastructure-actions">
                <button
                  className="settings-inline-action"
                  type="button"
                  onClick={() => void checkInfrastructureStatus()}
                  disabled={Boolean(busy)}
                >
                  {busy === "infrastructure-status" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                  설치 상태 확인
                </button>
                <button
                  className="infrastructure-install-button"
                  type="button"
                  onClick={() => void installInfrastructure()}
                  disabled={Boolean(busy) || infrastructureStatus?.state === "external"}
                >
                  {busy === "infrastructure-install" ? <LoaderCircle className="spin" size={16} /> : <CloudCog size={16} />}
                  {busy === "infrastructure-install"
                    ? "설치·업데이트 중"
                    : infrastructureStatus?.managed
                      ? "기존 설치 업데이트"
                      : infrastructureStatus?.state === "external"
                        ? "기존 Lambda 사용 중"
                        : "백업 Lambda 설치"}
                </button>
              </div>
              <small className="infrastructure-permission-note">
                최초 설치에는 CloudFormation, IAM, Lambda, EventBridge Scheduler 생성 권한이 필요합니다.
              </small>
            </div>
          </section>

          {notice && <div className="settings-notice is-success"><CheckCircle2 size={17} />{notice}</div>}
          {error && <div className="settings-notice is-error">{error}</div>}
          <div className="security-callout">
            <ShieldCheck size={20} />
            <p><strong>Secret Key는 설정 파일에 기록하지 않습니다.</strong> macOS Keychain 또는 Windows Credential Manager에서만 읽으며 로그 모닝 서버로 전송하지 않습니다.</p>
          </div>
        </div>

        <footer>
          <button className="button-secondary" type="button" onClick={onClose}>취소</button>
          <button className="button-primary" type="button" onClick={() => void save()} disabled={Boolean(busy)}>
            {busy === "save" && <LoaderCircle className="spin" size={16} />}
            설정 저장
          </button>
        </footer>
      </section>
    </div>
  );
}
