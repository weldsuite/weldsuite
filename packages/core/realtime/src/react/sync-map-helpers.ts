import type { EntitySyncConfig } from './use-realtime-sync';

/**
 * Invalidate-only sync-map entry. Each argument is a query-key prefix
 * (TanStack Query partial match).
 */
export function inv(
  ...invalidate: readonly (readonly unknown[])[]
): EntitySyncConfig {
  return { invalidate };
}
