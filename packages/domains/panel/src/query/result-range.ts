import type { PanelResolvedRange } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { ResolvedRange, TimeBounds } from './time';

/** The range a result reports back to the client. */
export function toResolvedRange(range: ResolvedRange, previous: TimeBounds | null): PanelResolvedRange {
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    timezone: range.timezone,
    clampedToRetention: range.clampedToRetention,
    previousFrom: previous ? previous.from.toISOString() : null,
    previousTo: previous ? previous.to.toISOString() : null,
  };
}
