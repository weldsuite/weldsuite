import '@tanstack/react-start/server-only';

import { and, eq, isNull, or } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { consoleAuditRow } from '@/lib/audit';
import { inMasterTransaction, masterSchema, type MasterDatabase } from '@/lib/db';
import { catalogFlag, parseFlagValue } from '@/lib/flags';
import { adminCopy, fill } from '@/lib/i18n';
import { generateId } from '@/lib/id';
import type { ActionResult } from './workspaces';

/**
 * Feature flag values on the Kubernetes editions (master
 * `feature_flag_overrides`, `lib/flags.ts`). Any admin but a viewer sets them;
 * each change and its `admin_audit_events` row commit together.
 */

const { featureFlagOverrides, workspaces, adminAuditEvents } = masterSchema;

function failure(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function checkedReason(reason: string): string | null {
  const trimmed = reason.trim();
  return trimmed.length >= 3 ? trimmed.slice(0, 500) : null;
}

/** The audit row's workspace (when the value is one workspace's) and target, the flag. */
function auditScope(workspaceId: string | null, flag: string) {
  return workspaceId ? { workspaceId, targetId: flag } : { workspaceId: null, targetId: flag };
}

/** A workspace by its id, slug or Clerk org id. */
async function findWorkspace(tx: MasterDatabase, ref: string) {
  const [ws] = await tx
    .select({ id: workspaces.id, clerkOrgId: workspaces.clerkOrgId, name: workspaces.name })
    .from(workspaces)
    .where(or(eq(workspaces.id, ref), eq(workspaces.clerkOrgId, ref), eq(workspaces.slug, ref)))
    .limit(1);
  return ws ?? null;
}

/** The row a flag has for everyone (`refs` empty) or for a workspace under any of its ids. */
function rowFor(flag: string, refs: string[]) {
  const scope =
    refs.length === 0 ? isNull(featureFlagOverrides.workspaceId) : or(...refs.map((ref) => eq(featureFlagOverrides.workspaceId, ref)));
  return and(eq(featureFlagOverrides.flagKey, flag), scope);
}

/** Sets a flag for everyone (`workspace` null) or for one workspace. */
export async function setFlag(input: {
  flag: string;
  workspace: string | null;
  value: string;
  reason: string;
}): Promise<ActionResult<{ flag: string }>> {
  const t = adminCopy().flags.errors;
  const guard = await guardWrite();
  if (!guard.ok) return failure(guard.error);
  const flag = catalogFlag(input.flag);
  if (!flag) return failure(fill(t.unknownFlag, { flag: input.flag }));
  const parsed = parseFlagValue(flag.type, input.value);
  if (!parsed.ok) return failure(t[parsed.error]);
  const reason = checkedReason(input.reason);
  if (!reason) return failure(adminCopy().staff.errors.reason);

  return inMasterTransaction(async (tx) => {
    const ref = input.workspace?.trim() || null;
    const ws = ref ? await findWorkspace(tx, ref) : null;
    if (ref && !ws) return failure(fill(t.noWorkspace, { workspace: ref }));
    const refs = ws ? [ws.id, ...(ws.clerkOrgId ? [ws.clerkOrgId] : [])] : [];

    const [before] = await tx.select().from(featureFlagOverrides).where(rowFor(flag.key, refs)).limit(1);
    const values = { value: parsed.value, workspaceId: ws?.id ?? null, updatedBy: guard.identity.email, updatedAt: new Date() };
    if (before) {
      await tx.update(featureFlagOverrides).set(values).where(eq(featureFlagOverrides.id, before.id));
    } else {
      await tx.insert(featureFlagOverrides).values({ id: generateId('ffo'), flagKey: flag.key, ...values });
    }
    await tx.insert(adminAuditEvents).values(
      consoleAuditRow({
        identity: guard.identity,
        action: 'flag.set',
        outcome: 'success',
        targetType: 'feature_flag',
        ...auditScope(ws?.id ?? null, flag.key),
        reason,
        details: { value: parsed.value, before: before ? before.value : null, scope: ws ? 'workspace' : 'everyone' },
      }),
    );
    return { ok: true as const, data: { flag: flag.key } };
  });
}

/** Removes a flag's value for everyone (`workspace` null) or one workspace's own value. */
export async function clearFlag(input: {
  flag: string;
  workspace: string | null;
  reason: string;
}): Promise<ActionResult<{ flag: string }>> {
  const t = adminCopy().flags.errors;
  const guard = await guardWrite();
  if (!guard.ok) return failure(guard.error);
  const flag = catalogFlag(input.flag);
  if (!flag) return failure(fill(t.unknownFlag, { flag: input.flag }));
  const reason = checkedReason(input.reason);
  if (!reason) return failure(adminCopy().staff.errors.reason);

  return inMasterTransaction(async (tx) => {
    const ref = input.workspace?.trim() || null;
    const ws = ref ? await findWorkspace(tx, ref) : null;
    // A row may name a workspace that no longer exists: clear it by what it holds.
    const refs = ref ? [...new Set([ref, ...(ws ? [ws.id, ...(ws.clerkOrgId ? [ws.clerkOrgId] : [])] : [])])] : [];
    const removed = await tx.delete(featureFlagOverrides).where(rowFor(flag.key, refs)).returning();
    if (removed.length === 0) return failure(t.notSet);
    await tx.insert(adminAuditEvents).values(
      consoleAuditRow({
        identity: guard.identity,
        action: 'flag.clear',
        outcome: 'success',
        targetType: 'feature_flag',
        ...auditScope(ws?.id ?? null, flag.key),
        reason,
        details: { before: removed[0]!.value, scope: ref ? 'workspace' : 'everyone' },
      }),
    );
    return { ok: true as const, data: { flag: flag.key } };
  });
}
