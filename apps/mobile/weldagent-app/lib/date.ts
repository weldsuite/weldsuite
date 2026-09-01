export function formatRelativeTime(
  value: string | Date | null | undefined,
  labels: { never: string; justNow: string; minutesAgo: string; hoursAgo: string; daysAgo: string },
  interpolate: (template: string, values?: Record<string, unknown>) => string,
): string {
  if (!value) return labels.never;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return labels.never;
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return labels.justNow;
  if (minutes < 60) return interpolate(labels.minutesAgo, { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return interpolate(labels.hoursAgo, { count: hours });
  const days = Math.floor(hours / 24);
  return interpolate(labels.daysAgo, { count: days });
}
