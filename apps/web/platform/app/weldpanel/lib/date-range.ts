/**
 * The date range every analytics page shares: a preset or custom days, the
 * interval a chart should group by, and the last choice remembered per browser.
 * Storage can be missing or throw, so access is guarded.
 */

import { useCallback, useState } from 'react';
import { PANEL_DATE_PRESETS, type PanelDateRange, type PanelInterval } from '@weldsuite/app-api-client/schemas/weldpanel-query';

export const DEFAULT_RANGE: PanelDateRange = { preset: '30d' };

const STORAGE_KEY = 'weldpanel:range';

export function isCustomRange(range: PanelDateRange): range is { from: string; to: string } {
  return 'from' in range;
}

export function rangesEqual(a: PanelDateRange, b: PanelDateRange): boolean {
  if (isCustomRange(a) && isCustomRange(b)) return a.from === b.from && a.to === b.to;
  if (!isCustomRange(a) && !isCustomRange(b)) return a.preset === b.preset;
  return false;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Parses what was stored; anything unexpected falls back to the default. */
export function parseRange(value: unknown): PanelDateRange {
  if (typeof value !== 'object' || value === null) return DEFAULT_RANGE;
  const v = value as Record<string, unknown>;
  if (typeof v.preset === 'string' && (PANEL_DATE_PRESETS as readonly string[]).includes(v.preset)) {
    return { preset: v.preset as (typeof PANEL_DATE_PRESETS)[number] };
  }
  if (typeof v.from === 'string' && typeof v.to === 'string' && YMD.test(v.from) && YMD.test(v.to) && v.from <= v.to) {
    return { from: v.from, to: v.to };
  }
  return DEFAULT_RANGE;
}

export function readStoredRange(): PanelDateRange {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? parseRange(JSON.parse(raw)) : DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
}

function writeStoredRange(range: PanelDateRange): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(range));
  } catch {
    // The next visit starts from the default range.
  }
}

/** The range state of a page, initialised from the last one used on any analytics page. */
export function useDateRange(): [PanelDateRange, (range: PanelDateRange) => void] {
  const [range, setRange] = useState<PanelDateRange>(readStoredRange);
  const update = useCallback((next: PanelDateRange) => {
    setRange(next);
    writeStoredRange(next);
  }, []);
  return [range, update];
}

/** Days from `from` to `to`, both included. */
export function daysInRange(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

/** A sensible chart interval for a range: hours for today, days up to two months, weeks to a half year, then months. */
export function defaultInterval(range: PanelDateRange): PanelInterval {
  if (isCustomRange(range)) {
    const days = daysInRange(range.from, range.to);
    if (days <= 2) return 'hour';
    if (days <= 62) return 'day';
    if (days <= 200) return 'week';
    return 'month';
  }
  switch (range.preset) {
    case 'today':
      return 'hour';
    case '7d':
    case '30d':
      return 'day';
    case '90d':
      return 'week';
    default:
      return 'month';
  }
}

/** Today as `YYYY-MM-DD` (local time), for the custom range's max. */
export function todayYmd(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The browser's IANA timezone: days and weeks are cut where the viewer lives. Falls back to UTC. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
