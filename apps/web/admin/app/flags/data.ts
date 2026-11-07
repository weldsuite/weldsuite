import '@tanstack/react-start/server-only';

import { inArray, or } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { catalogFlags, formatFlagValue } from '@/lib/flags';

const { featureFlagOverrides, workspaces } = masterSchema;

/** Every catalog flag, with its value for everyone and each workspace's own value. */
export async function loadFlagsPage() {
  const identity = await requireAdmin();
  const db = getMasterDb();
  const rows = await db.select().from(featureFlagOverrides);

  // A workspace row names `workspaces.id`, or the Clerk org id on older rows.
  const refs = [...new Set(rows.map((row) => row.workspaceId).filter((ref): ref is string => ref !== null))];
  const named =
    refs.length === 0
      ? []
      : await db
          .select({ id: workspaces.id, clerkOrgId: workspaces.clerkOrgId, name: workspaces.name, slug: workspaces.slug })
          .from(workspaces)
          .where(or(inArray(workspaces.id, refs), inArray(workspaces.clerkOrgId, refs)));
  const workspaceOf = (ref: string) => named.find((ws) => ws.id === ref || ws.clerkOrgId === ref) ?? null;
  const stamp = (row: (typeof rows)[number]) => ({
    value: formatFlagValue(row.value),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  });

  const flags = catalogFlags().map((flag) => {
    const own = rows.filter((row) => row.flagKey === flag.key);
    const everyone = own.find((row) => row.workspaceId === null);
    return {
      key: flag.key,
      type: flag.type,
      default: formatFlagValue(flag.default),
      everyone: everyone ? stamp(everyone) : null,
      workspaces: own
        .filter((row) => row.workspaceId !== null)
        .map((row) => {
          const ws = workspaceOf(row.workspaceId!);
          return { ref: row.workspaceId!, workspaceId: ws?.id ?? null, name: ws?.name ?? null, slug: ws?.slug ?? null, ...stamp(row) };
        }),
    };
  });

  return { flags, canWrite: identity.role !== 'viewer' };
}

export type FlagsPageData = Awaited<ReturnType<typeof loadFlagsPage>>;
export type FlagRow = FlagsPageData['flags'][number];
