import type { LogEvent } from "../types";

export type LogEnvironment = "prod" | "dev" | "unknown";
export type EnvironmentFilter = "all" | LogEnvironment;

export interface LogEventFilters {
  environment: EnvironmentFilter;
  logGroup: string;
  logStream: string;
}

export function environmentForLogGroup(logGroup: string): LogEnvironment {
  const name = logGroup.toLowerCase();
  if (/(^|[-_/])(dev|development)([-_/]|$)/.test(name)) return "dev";
  if (/(^|[-_/])(prod|production)([-_/]|$)/.test(name)) return "prod";
  return "unknown";
}

export function matchesLogFilters(event: LogEvent, filters: LogEventFilters): boolean {
  if (
    filters.environment !== "all" &&
    environmentForLogGroup(event.logGroup) !== filters.environment
  ) {
    return false;
  }
  if (filters.logGroup && event.logGroup !== filters.logGroup) return false;
  if (filters.logStream && event.logStream !== filters.logStream) return false;
  return true;
}

export function filterLogEvents(events: LogEvent[], filters: LogEventFilters): LogEvent[] {
  return events.filter((event) => matchesLogFilters(event, filters));
}
