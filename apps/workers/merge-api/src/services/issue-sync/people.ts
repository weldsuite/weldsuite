/**
 * Labels and assignees across the seam. Labels match by name (case-insensitive);
 * a provider label WeldMerge does not have is created as a label of the issue's
 * team. An assignee matches through the member's linked provider account.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import { mergeLabels, mergeProviderAccounts, type Db } from '../db';
import type { PendingEvent } from '../events';
import { createLabel } from '../labels';

/** WeldMerge label ids for provider label names, creating the missing ones as team labels. */
export async function resolveLabelIds(
  db: Db,
  teamId: string,
  names: readonly string[],
): Promise<{ ids: string[]; events: PendingEvent[] }> {
  const wanted = [...new Map(names.filter((n) => n !== '').map((n) => [n.toLowerCase(), n])).entries()];
  if (wanted.length === 0) return { ids: [], events: [] };
  const existing = await db
    .select()
    .from(mergeLabels)
    .where(
      and(
        isNull(mergeLabels.deletedAt),
        or(eq(mergeLabels.teamId, teamId), isNull(mergeLabels.teamId)),
        inArray(
          sql`lower(${mergeLabels.name})`,
          wanted.map(([lower]) => lower),
        ),
      ),
    );
  // The team's own label wins over a workspace-wide one of the same name.
  const byName = new Map<string, string>();
  for (const label of existing.filter((l) => l.teamId === null)) byName.set(label.name.toLowerCase(), label.id);
  for (const label of existing.filter((l) => l.teamId !== null)) byName.set(label.name.toLowerCase(), label.id);

  const events: PendingEvent[] = [];
  const ids: string[] = [];
  for (const [lower, name] of wanted) {
    let id = byName.get(lower);
    if (!id) {
      const created = await createLabel(db, { teamId, name: name.slice(0, 100) });
      if (!created.ok) continue;
      id = created.label.id;
      events.push({
        entityType: 'merge_label',
        action: 'created',
        entityId: id,
        data: { id, teamId, name: created.label.name },
      });
    }
    ids.push(id);
  }
  return { ids, events };
}

/** The names of labels, for pushing to the provider; labels that no longer exist are left out. */
export async function labelNames(db: Db, labelIds: readonly string[]): Promise<string[]> {
  if (labelIds.length === 0) return [];
  const rows = await db
    .select({ name: mergeLabels.name })
    .from(mergeLabels)
    .where(and(inArray(mergeLabels.id, [...labelIds]), isNull(mergeLabels.deletedAt)));
  return rows.map((r) => r.name);
}

const hostMatch = (host: string | null) => (host ? eq(mergeProviderAccounts.host, host) : isNull(mergeProviderAccounts.host));

/** The member whose linked account has this provider login, if any. */
export async function memberForLogin(db: Db, provider: MergeProvider, host: string | null, login: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: mergeProviderAccounts.userId })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.provider, provider), hostMatch(host), eq(mergeProviderAccounts.login, login.toLowerCase())))
    .limit(1);
  return row?.userId ?? null;
}

/** The member's provider login, if they linked an account. */
export async function loginForMember(db: Db, provider: MergeProvider, host: string | null, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ login: mergeProviderAccounts.login })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.provider, provider), hostMatch(host), eq(mergeProviderAccounts.userId, userId)))
    .limit(1);
  return row?.login ?? null;
}

/**
 * The assignee a provider issue maps to. A provider assignee with no linked
 * member leaves the current one alone (nothing to map it to); no provider
 * assignee clears the current one only when it is a member with a linked
 * account (who could have been the provider's), so an assignee that never
 * existed on the provider is not wiped by an unrelated edit.
 */
export async function resolveAssignee(
  db: Db,
  provider: MergeProvider,
  host: string | null,
  providerLogin: string | null,
  currentUserId: string | null,
): Promise<string | null> {
  if (providerLogin) return (await memberForLogin(db, provider, host, providerLogin)) ?? currentUserId;
  if (!currentUserId) return null;
  return (await loginForMember(db, provider, host, currentUserId)) ? null : currentUserId;
}
