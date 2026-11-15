import '@tanstack/react-start/server-only';

import { and, eq, sql } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { consoleAuditRow } from '@/lib/audit';
import { inMasterTransaction, masterSchema, type MasterDatabase } from '@/lib/db';
import { adminCopy, fill } from '@/lib/i18n';
import { generateId } from '@/lib/id';
import type { AdminRole } from '@/lib/roles';
import { keepsASuperadmin, mayChangeStaff, normalizeStaffEmail, parseStaffRole } from '@/lib/staff';
import type { ActionResult } from './workspaces';

/**
 * The staff list's writes on the Kubernetes editions (master `admin_users`,
 * ADR SEC-014), with the rules `weldsuite admin staff` applies: a superadmin
 * acts, the last active superadmin stays, a removal keeps the row. Each change
 * and its `admin_audit_events` row commit together.
 */

const { adminUsers, adminAuditEvents } = masterSchema;

function failure(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** The signed-in superadmin, or why they may not change the list. */
async function superadmin() {
  const guard = await guardWrite();
  if (!guard.ok) return guard;
  if (!mayChangeStaff(guard.identity.role)) return failure(adminCopy().staff.errors.notSuperadmin);
  return guard;
}

function checkedReason(reason: string): string | null {
  const trimmed = reason.trim();
  return trimmed.length >= 3 ? trimmed.slice(0, 500) : null;
}

/**
 * The person's platform account, as `weldsuite admin staff add` finds it
 * (`rust/crates/staff-domain/src/staff.rs`, ADR SEC-018): a master `users` row
 * with this email that belongs to a workspace and isn't a row's console
 * account. The identity sync copies staff-organization accounts into `users`
 * too, with the same email, so the email alone could name either.
 */
function platformAccount(email: string) {
  return sql`(select u.id from users u
    where lower(u.email) = ${email} and u.is_active
      and exists (select 1 from user_workspaces m where m.user_id = u.id)
      and not exists (select 1 from admin_users s where s.console_subject = u.id)
    order by u.created_at, u.id
    limit 1)`;
}

/** The active superadmins, locked until the transaction ends, so two demotions can't both pass. */
async function lockedSuperadmins(tx: MasterDatabase): Promise<number> {
  const rows = await tx
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(and(eq(adminUsers.isActive, true), eq(adminUsers.role, 'superadmin')))
    .for('update');
  return rows.length;
}

/** Adds someone, or brings them back or changes their role (the CLI's `staff add`). */
export async function addStaff(input: {
  email: string;
  role: string;
  name?: string | null;
  reason: string;
}): Promise<ActionResult<{ email: string; role: AdminRole }>> {
  const t = adminCopy().staff.errors;
  const guard = await superadmin();
  if (!guard.ok) return failure(guard.error);
  const email = normalizeStaffEmail(input.email);
  if (!email) return failure(t.invalidEmail);
  const role = parseStaffRole(input.role);
  if (!role) return failure(t.invalidRole);
  const reason = checkedReason(input.reason);
  if (!reason) return failure(t.reason);
  const name = input.name?.trim().slice(0, 255) || null;

  return inMasterTransaction(async (tx) => {
    const superadmins = await lockedSuperadmins(tx);
    const [before] = await tx
      .select({ role: adminUsers.role, isActive: adminUsers.isActive })
      .from(adminUsers)
      .where(eq(adminUsers.email, email))
      .limit(1);
    if (!keepsASuperadmin(before ?? null, role === 'superadmin', superadmins)) return failure(t.lastSuperadmin);

    await tx
      .insert(adminUsers)
      .values({
        id: generateId('adm'),
        email,
        name,
        role,
        isActive: true,
        // For the WeldApps review gate; the console binds its own account on first sign-in.
        userId: platformAccount(email),
        invitedBy: guard.identity.email,
      })
      .onConflictDoUpdate({
        target: adminUsers.email,
        set: {
          role,
          isActive: true,
          name: sql`coalesce(excluded.name, ${adminUsers.name})`,
          // The account found now, else the one the row had, unless that is
          // the console's own account (which a row bound before SEC-018 holds).
          userId: sql`coalesce(excluded.user_id, nullif(${adminUsers.userId}, ${adminUsers.consoleSubject}))`,
          updatedAt: new Date(),
        },
      });
    await tx.insert(adminAuditEvents).values(
      consoleAuditRow({
        identity: guard.identity,
        action: 'staff.add',
        outcome: 'success',
        targetType: 'admin_user',
        workspaceId: null,
        targetId: email,
        reason,
        details: { role, before: before ?? null, bootstrap: false },
      }),
    );
    return { ok: true as const, data: { email, role } };
  });
}

/** Takes someone off the list (the CLI's `staff remove`); their row stays for the trail. */
export async function removeStaff(input: {
  email: string;
  reason: string;
}): Promise<ActionResult<{ email: string }>> {
  const t = adminCopy().staff.errors;
  const guard = await superadmin();
  if (!guard.ok) return failure(guard.error);
  const email = normalizeStaffEmail(input.email);
  if (!email) return failure(t.invalidEmail);
  const reason = checkedReason(input.reason);
  if (!reason) return failure(t.reason);

  return inMasterTransaction(async (tx) => {
    const superadmins = await lockedSuperadmins(tx);
    const [before] = await tx
      .select({ id: adminUsers.id, role: adminUsers.role, isActive: adminUsers.isActive })
      .from(adminUsers)
      .where(eq(adminUsers.email, email))
      .limit(1);
    if (!before?.isActive) return failure(fill(t.notOnList, { email }));
    if (!keepsASuperadmin(before, false, superadmins)) return failure(t.lastSuperadmin);

    await tx.update(adminUsers).set({ isActive: false, updatedAt: new Date() }).where(eq(adminUsers.id, before.id));
    await tx.insert(adminAuditEvents).values(
      consoleAuditRow({
        identity: guard.identity,
        action: 'staff.remove',
        outcome: 'success',
        targetType: 'admin_user',
        workspaceId: null,
        targetId: email,
        reason,
        details: { role: before.role },
      }),
    );
    return { ok: true as const, data: { email } };
  });
}
