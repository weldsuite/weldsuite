/** Reading the usage numbers: how full a meter is, and which banner (if any) the module shows. */

import type { PanelUsageDto, PanelUsageMeter } from '@weldsuite/app-api-client/schemas/weldpanel-objects';

export const WARN_AT = 0.8;

/** 0-1+ (above 1 once over the allowance); 0 when the plan has no allowance to compare with. */
export function usageRatio(meter: Pick<PanelUsageMeter, 'used' | 'allowance'>): number {
  return meter.allowance > 0 ? meter.used / meter.allowance : 0;
}

export type MeterTone = 'ok' | 'warning' | 'over';

export function meterTone(ratio: number): MeterTone {
  if (ratio >= 1) return 'over';
  if (ratio >= WARN_AT) return 'warning';
  return 'ok';
}

export type UsageBanner =
  | { kind: 'events_blocked' }
  | { kind: 'replay_blocked' }
  | { kind: 'reached'; what: 'events' | 'recordings' | 'both' }
  | { kind: 'warning'; what: 'events' | 'recordings' | 'both'; ratio: number };

/** The most serious thing to tell someone who manages the plan, or null when all is well. */
export function usageBanner(usage: PanelUsageDto): UsageBanner | null {
  if (usage.quota === 'events_blocked') return { kind: 'events_blocked' };
  if (usage.quota === 'replay_blocked') return { kind: 'replay_blocked' };
  const events = usageRatio(usage.events);
  const recordings = usageRatio(usage.recordings);
  const what = (a: boolean, b: boolean): 'events' | 'recordings' | 'both' => {
    if (a && b) return 'both';
    return a ? 'events' : 'recordings';
  };
  if (events >= 1 || recordings >= 1) return { kind: 'reached', what: what(events >= 1, recordings >= 1) };
  if (events >= WARN_AT || recordings >= WARN_AT) return { kind: 'warning', what: what(events >= WARN_AT, recordings >= WARN_AT), ratio: Math.max(events, recordings) };
  return null;
}

/** A key that changes when the banner's message does, so a dismissal holds only for that message. */
export function bannerKey(banner: UsageBanner, month: string): string {
  return `${month}:${banner.kind}:${'what' in banner ? banner.what : ''}`;
}
