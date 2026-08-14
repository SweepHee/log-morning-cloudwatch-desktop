export type LogTab = "all" | "errors" | "warnings" | "businessFailures";
export type AwsAuthMode = "auto" | "profile" | "accessKey";

export interface AwsSettings {
  authMode: AwsAuthMode;
  profile: string;
  bucket: string;
  region: string;
  dailyPrefix: string;
  lambdaFunction: string;
  logGroups: string[];
  logStreams: Record<string, string[]>;
}

export interface AccessKeyInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface CredentialStatus {
  stored: boolean;
  accessKeyHint: string;
}

export interface ConnectionStatus {
  connected: boolean;
  bucket: string;
  region: string;
  profile: string;
  accountId: string;
  arn: string;
  message: string;
}

export interface S3BucketSummary {
  name: string;
}

export interface CloudWatchLogGroupSummary {
  name: string;
  storedBytes: number;
  retentionDays: number | null;
}

export interface CloudWatchLogStreamSummary {
  name: string;
  lastEventTimestamp: number | null;
}

export interface BackupDaySummary {
  date: string;
  prefix: string;
  status: string;
  generatedAt: string;
  windowStartKst: string;
  windowEndKst: string;
  total: number;
  error: number;
  warn: number;
  businessFailure: number;
  sourceErrorCount: number;
}

export interface CurrentBackupRefresh {
  prefix: string;
  status: string;
}

export interface BackupInfrastructureStatus {
  state: "missing" | "external" | "installing" | "ready" | "failed";
  stackName: string;
  stackStatus: string;
  managed: boolean;
  installed: boolean;
  message: string;
}

export interface LogEvent {
  timestamp: string;
  ingestionTime: string;
  timestampMs: number;
  ingestionTimeMs: number;
  logGroup: string;
  logStream?: string | null;
  eventId?: string | null;
  level: string;
  businessFailure: boolean;
  message: string;
}

export interface DayLogData {
  summary: BackupDaySummary;
  all: LogEvent[];
  errors: LogEvent[];
  warnings: LogEvent[];
  businessFailures: LogEvent[];
}

export interface IssueGroup {
  id: string;
  fingerprint: string;
  title: string;
  count: number;
  events: LogEvent[];
  logGroups: string[];
  lastSeen: string;
  firstSeen: string;
  hourCounts: number[];
}
