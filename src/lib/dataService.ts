import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AccessKeyInput,
  AwsSettings,
  BackupInfrastructureStatus,
  BackupDaySummary,
  CloudWatchLogGroupSummary,
  CloudWatchLogStreamSummary,
  ConnectionStatus,
  CredentialStatus,
  CurrentBackupRefresh,
  DayLogData,
  S3BucketSummary,
} from "../types";
import { mockDayData, mockDays } from "./mockData";

export interface ExportFileResult {
  saved: boolean;
  path: string | null;
}

export const isDesktopRuntime = "__TAURI_INTERNALS__" in window;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function checkConnection(settings: AwsSettings): Promise<ConnectionStatus> {
  if (isDesktopRuntime) return invoke<ConnectionStatus>("check_aws_connection", { settings });
  await delay(250);
  return {
    connected: true,
    bucket: settings.bucket,
    region: settings.region,
    profile: settings.authMode === "profile" ? `${settings.profile} profile` : settings.authMode,
    accountId: "000000000000",
    arn: "design-preview",
    message: "브라우저 디자인 미리보기 모드입니다.",
  };
}

export async function listBackupDays(settings: AwsSettings): Promise<BackupDaySummary[]> {
  if (isDesktopRuntime) return invoke<BackupDaySummary[]>("list_backup_days", { settings });
  await delay(320);
  return mockDays;
}

export async function loadBackupDay(settings: AwsSettings, prefix: string): Promise<DayLogData> {
  if (isDesktopRuntime) return invoke<DayLogData>("load_backup_day", { settings, prefix });
  await delay(420);
  const summary = mockDays.find((day) => day.prefix === prefix) ?? mockDayData.summary;
  return { ...mockDayData, summary };
}

export async function refreshCurrentBackup(settings: AwsSettings): Promise<CurrentBackupRefresh> {
  if (isDesktopRuntime) {
    return invoke<CurrentBackupRefresh>("refresh_current_backup", { settings });
  }
  await delay(900);
  return { prefix: mockDays[0].prefix, status: "in_progress" };
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  if (isDesktopRuntime) return invoke<CredentialStatus>("get_credential_status");
  return { stored: false, accessKeyHint: "" };
}

export async function saveAccessKey(input: AccessKeyInput): Promise<CredentialStatus> {
  if (isDesktopRuntime) return invoke<CredentialStatus>("save_access_key", { input });
  return { stored: true, accessKeyHint: `••••${input.accessKeyId.slice(-4)}` };
}

export async function deleteAccessKey(): Promise<CredentialStatus> {
  if (isDesktopRuntime) return invoke<CredentialStatus>("delete_access_key");
  return { stored: false, accessKeyHint: "" };
}

export async function listS3Buckets(settings: AwsSettings): Promise<S3BucketSummary[]> {
  if (isDesktopRuntime) return invoke<S3BucketSummary[]>("list_s3_buckets", { settings });
  return settings.bucket ? [{ name: settings.bucket }] : [];
}

export async function listCloudWatchLogGroups(
  settings: AwsSettings,
): Promise<CloudWatchLogGroupSummary[]> {
  if (isDesktopRuntime) {
    return invoke<CloudWatchLogGroupSummary[]>("list_cloudwatch_log_groups", { settings });
  }
  return [
    { name: "/aws/lambda/example-api", storedBytes: 1_240_000, retentionDays: 30 },
    { name: "/ecs/example-backend", storedBytes: 8_600_000, retentionDays: 14 },
  ];
}

export async function listCloudWatchLogStreams(
  settings: AwsSettings,
  logGroupName: string,
): Promise<CloudWatchLogStreamSummary[]> {
  if (isDesktopRuntime) {
    return invoke<CloudWatchLogStreamSummary[]>("list_cloudwatch_log_streams", {
      settings,
      logGroupName,
    });
  }
  return [{ name: `${logGroupName}/example`, lastEventTimestamp: Date.now() }];
}

export async function getBackupInfrastructureStatus(
  settings: AwsSettings,
): Promise<BackupInfrastructureStatus> {
  if (isDesktopRuntime) {
    return invoke<BackupInfrastructureStatus>("get_backup_infrastructure_status", { settings });
  }
  await delay(300);
  return {
    state: "missing",
    stackName: "log-morning-cloudwatch-backup",
    stackStatus: "",
    managed: false,
    installed: false,
    message: "브라우저 미리보기에서는 아직 설치되지 않은 상태로 표시합니다.",
  };
}

export async function installBackupInfrastructure(
  settings: AwsSettings,
): Promise<BackupInfrastructureStatus> {
  if (isDesktopRuntime) {
    return invoke<BackupInfrastructureStatus>("install_backup_infrastructure", { settings });
  }
  await delay(900);
  return {
    state: "ready",
    stackName: "log-morning-cloudwatch-backup",
    stackStatus: "CREATE_COMPLETE",
    managed: true,
    installed: true,
    message: "브라우저 미리보기용 설치 완료 상태입니다.",
  };
}

export async function saveIssueExport(
  suggestedName: string,
  extension: "txt" | "json",
  contents: string,
): Promise<ExportFileResult> {
  if (isDesktopRuntime) {
    return invoke<ExportFileResult>("export_issue_file", { suggestedName, extension, contents });
  }

  const blob = new Blob([contents], { type: extension === "json" ? "application/json" : "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { saved: true, path: suggestedName };
}

export async function revealIssueExport(path: string): Promise<void> {
  if (!isDesktopRuntime) {
    throw new Error("데스크톱 앱에서만 저장 위치를 열 수 있습니다.");
  }
  await revealItemInDir(path);
}
