import type { AwsSettings } from "../types";

export interface BackupLogSource {
  group: string;
  streams?: string[];
}

/** Lambda/CloudFormation 배포 도구가 읽는 공개 형식의 로그 소스 목록을 만든다. */
export function backupSourcesFor(settings: AwsSettings): BackupLogSource[] {
  return settings.logGroups.map((group) => {
    const streams = [...new Set((settings.logStreams[group] ?? []).map((stream) => stream.trim()))]
      .filter(Boolean)
      .slice(0, 100);
    return streams.length > 0 ? { group, streams } : { group };
  });
}

export function backupSourcesJson(settings: AwsSettings): string {
  return `${JSON.stringify(backupSourcesFor(settings), null, 2)}\n`;
}
