export const SIDEBAR_COLLAPSED_KEY = "log-morning.sidebar-collapsed";

export function normalizeSidebarCollapsed(value: string | null): boolean {
  return value === "true";
}
