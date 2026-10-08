/**
 * How the nexus monitor shows a state: the color of its progress bar, the chip
 * of its alert and the filters of the table. Thresholds follow the server: a
 * state is flagged as approaching at 80% of a threshold and has nexus at 100%.
 */
import type { NexusAlert, NexusRow, NexusStatus } from '@/lib/api/domains/weldbooks-sales-tax-center';

export const NEXUS_WATCH_PERCENT = 80;
export const NEXUS_EXCEEDED_PERCENT = 100;

export type BarTone = 'neutral' | 'watch' | 'exceeded' | 'registered';

/**
 * The color class of a state's progress bar: neutral below 80%, watch from 80%,
 * exceeded from 100%. A state where you are already registered is green from
 * 80% on: nothing is left to do.
 */
export function barTone(row: Pick<NexusRow, 'percentOfThreshold' | 'registered'>): BarTone {
  if (row.registered && row.percentOfThreshold >= NEXUS_WATCH_PERCENT) return 'registered';
  if (row.percentOfThreshold >= NEXUS_EXCEEDED_PERCENT) return 'exceeded';
  if (row.percentOfThreshold >= NEXUS_WATCH_PERCENT) return 'watch';
  return 'neutral';
}

/** The width of the filled part of a bar, in percent: never below 0 or above 100. */
export function barWidth(percentOfThreshold: number): number {
  if (!Number.isFinite(percentOfThreshold)) return 0;
  return Math.min(100, Math.max(0, percentOfThreshold));
}

export type ChipVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

/** The chip of an alert: register now is red, watch is amber, registered is green, ok is plain. */
export function alertVariant(alert: NexusAlert): ChipVariant {
  switch (alert) {
    case 'register':
      return 'destructive';
    case 'watch':
      return 'warning';
    case 'registered':
      return 'success';
    default:
      return 'outline';
  }
}

/** The chip of a measurement status; an exceeded state you are registered in is not a problem. */
export function statusVariant(status: NexusStatus, registered: boolean): ChipVariant {
  if (status === 'exceeded') return registered ? 'secondary' : 'destructive';
  if (status === 'approaching') return 'warning';
  return 'outline';
}

export type AlertFilter = 'all' | NexusAlert;

export const ALERT_FILTERS: readonly AlertFilter[] = ['all', 'register', 'watch', 'registered', 'ok'];

/** States that pass the alert filter and the search text (state code or name). Order is kept: the server sorts by progress. */
export function filterNexusRows(rows: readonly NexusRow[], filter: { alert: AlertFilter; query: string }): NexusRow[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.alert !== 'all' && row.alert !== filter.alert) return false;
    if (!query) return true;
    return row.stateCode.toLowerCase().includes(query) || row.stateName.toLowerCase().includes(query);
  });
}

/** Number of states per alert, for the filter labels and the summary cards. */
export function countByAlert(rows: readonly NexusRow[]): Record<NexusAlert, number> {
  const counts: Record<NexusAlert, number> = { register: 0, watch: 0, registered: 0, ok: 0 };
  for (const row of rows) counts[row.alert] += 1;
  return counts;
}

/** A percent as the monitor prints it: no trailing zeros, at most two decimals. */
export function formatPercent(percent: number): string {
  return String(Number(percent.toFixed(2)));
}
