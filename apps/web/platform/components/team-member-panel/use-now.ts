import { useEffect, useState } from 'react';

// Re-renders every `intervalMs` (default 30s) so the panel header stays
// current without spinning a per-second timer.
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function formatLocalTime(now: Date, timezone: string, locale = 'en-US'): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return '—';
  }
}

export function formatTimezoneOffset(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(now);
    const off = parts.find((p) => p.type === 'timeZoneName')?.value;
    return off ?? '';
  } catch {
    return '';
  }
}
