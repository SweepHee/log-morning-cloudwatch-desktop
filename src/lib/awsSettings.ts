import type { AwsAuthMode, AwsSettings } from "../types";

export const AWS_SETTINGS_KEY = "log-morning.aws-settings.v1";

export const DEFAULT_AWS_SETTINGS: AwsSettings = {
  authMode: "auto",
  profile: "",
  region: "ap-northeast-2",
  bucket: "",
  dailyPrefix: "log-morning/daily/",
  lambdaFunction: "log-morning-cloudwatch-backup",
  logGroups: [],
  logStreams: {},
};

const AUTH_MODES = new Set<AwsAuthMode>(["auto", "profile", "accessKey"]);

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizeAwsSettings(value: unknown): AwsSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_AWS_SETTINGS };
  const candidate = value as Partial<AwsSettings>;
  const authMode = AUTH_MODES.has(candidate.authMode as AwsAuthMode)
    ? (candidate.authMode as AwsAuthMode)
    : DEFAULT_AWS_SETTINGS.authMode;
  return {
    authMode,
    profile: stringValue(candidate.profile, "").trim(),
    region: stringValue(candidate.region, DEFAULT_AWS_SETTINGS.region).trim(),
    bucket: stringValue(candidate.bucket, "").trim(),
    dailyPrefix: stringValue(candidate.dailyPrefix, DEFAULT_AWS_SETTINGS.dailyPrefix).trim(),
    lambdaFunction: stringValue(
      candidate.lambdaFunction,
      DEFAULT_AWS_SETTINGS.lambdaFunction,
    ).trim(),
    logGroups: Array.isArray(candidate.logGroups)
      ? [...new Set(candidate.logGroups.filter((item): item is string => typeof item === "string"))]
      : [],
    logStreams:
      candidate.logStreams && typeof candidate.logStreams === "object"
        ? Object.fromEntries(
            Object.entries(candidate.logStreams)
              .filter((entry): entry is [string, string[]] =>
                Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string"),
              )
              .map(([group, streams]) => [group, [...new Set(streams)]]),
          )
        : {},
  };
}

export function loadAwsSettings(): AwsSettings {
  try {
    const serialized = localStorage.getItem(AWS_SETTINGS_KEY);
    return serialized ? normalizeAwsSettings(JSON.parse(serialized)) : { ...DEFAULT_AWS_SETTINGS };
  } catch {
    return { ...DEFAULT_AWS_SETTINGS };
  }
}

export function saveAwsSettings(settings: AwsSettings): AwsSettings {
  const normalized = normalizeAwsSettings(settings);
  localStorage.setItem(AWS_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function hasMinimumBackupSettings(settings: AwsSettings): boolean {
  return Boolean(settings.region.trim() && settings.bucket.trim() && settings.dailyPrefix.trim());
}
