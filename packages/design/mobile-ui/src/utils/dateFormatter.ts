/** "7 Oct", or "7 Oct 2025" when the date falls in a different year than `now`. */
function formatDayMonth(date: Date, now: Date): string {
  const dayMonth = `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}`;
  return date.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth} ${date.getFullYear()}`;
}

export function formatEmailTime(utcDateString: string): string {
  const date = new Date(utcDateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const emailDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (today.getTime() === emailDay.getTime()) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  return formatDayMonth(date, now);
}

export function formatEmailDate(utcDateString: string): string {
  const date = new Date(utcDateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const emailDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffMs = today.getTime() - emailDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  return formatDayMonth(date, now);
}

/** Same rendering as {@link formatEmailTime}: time today, otherwise day + month (+ year). */
export const formatShortTime = formatEmailTime;

export function formatFullDateTime(utcDateString: string): string {
  const date = new Date(utcDateString);
  const dateString = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeString = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${dateString} at ${timeString}`;
}
