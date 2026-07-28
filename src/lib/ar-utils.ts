// Arabic localization helpers

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("ar-SA").format(n);
}

export function formatPercent(n: number, decimals = 1): string {
  return new Intl.NumberFormat("ar-SA", {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(n / 100);
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} دقيقة`;
  if (hours < 24) return `${Math.round(hours * 10) / 10} ساعة`;
  const days = hours / 24;
  return `${Math.round(days * 10) / 10} يوم`;
}

export const STATUS_LABELS: Record<string, string> = {
  open: "مفتوحة",
  in_progress: "قيد المعالجة",
  closed: "مغلقة",
  reopened: "معاد فتحها",
  rejected: "مرفوضة",
};

export const PRIORITY_LABELS: Record<string, string> = {
  low: "منخفضة",
  medium: "متوسطة",
  high: "عالية",
  critical: "حرجة",
};

export const SEVERITY_LABELS: Record<string, string> = {
  low: "منخفضة",
  medium: "متوسطة",
  high: "عالية",
  critical: "حرجة",
};

export const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  closed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  reopened: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  rejected: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
};

export const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  medium: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  critical: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

export function statusBadgeClass(status: string): string {
  return STATUS_COLORS[status] || STATUS_COLORS.open;
}

export function priorityBadgeClass(priority: string): string {
  return PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium;
}
