/**
 * Object keys in the private EU replays bucket (`weldsuite-panel-replays`,
 * `-test` for test; ADR PANEL-005). The bucket has no public domain: the
 * player reads chunks through panel-api after a permission check.
 *
 * Retention is an R2 lifecycle rule per tier prefix, so the tier is the first
 * path segment. A favourite is copied to `keep/` (13 months); erasure deletes
 * the original and any `keep/` copy.
 */

export const REPLAY_TIERS = ['30d', '90d', 'keep'] as const;
export type ReplayTier = (typeof REPLAY_TIERS)[number];

/** Days each lifecycle tier keeps an object; `keep` is a favourite. */
export const REPLAY_TIER_DAYS: Record<ReplayTier, number> = { '30d': 30, '90d': 90, keep: 396 };

/** `<tier>/<workspace>/<project>/<yyyy-mm-dd>/<session>/<seq>.json.gz`. `day` is the session's UTC start day. */
export function replayChunkKey(input: {
  tier: ReplayTier;
  workspaceId: string;
  projectId: string;
  day: string;
  sessionId: string;
  seq: number;
}): string {
  return `${input.tier}/${input.workspaceId}/${input.projectId}/${input.day}/${input.sessionId}/${input.seq}.json.gz`;
}

/** The same chunk under the `keep/` prefix (a favourite's copy). */
export function keepCopyKey(r2Key: string): string {
  const slash = r2Key.indexOf('/');
  return `keep/${slash === -1 ? r2Key : r2Key.slice(slash + 1)}`;
}

/** Heatmap backgrounds: one masked full snapshot per page group and device class, overwritten when a newer one arrives. */
export function heatmapSnapshotKey(input: {
  workspaceId: string;
  projectId: string;
  pageGroupId: string;
  deviceClass: 'desktop' | 'tablet' | 'mobile';
}): string {
  return `snapshots/${input.workspaceId}/${input.projectId}/${input.pageGroupId}/${input.deviceClass}.json.gz`;
}
