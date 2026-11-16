import { MAX_RETENTION_DAYS } from './context';

/** Events are kept 12 months on the free plan (no plan counts as free) and 25 months above (weldsuite-documentation/plans/weldpanel.md "Open items"). */
export function eventRetentionDays(planSlug: string | null | undefined): number {
  return !planSlug || planSlug === 'free' ? 366 : MAX_RETENTION_DAYS;
}
