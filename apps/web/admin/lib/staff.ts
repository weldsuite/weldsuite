/**
 * The staff list's rules (master `admin_users`, ADR SEC-014), the same ones
 * `weldsuite admin staff` applies (`rust/crates/staff-domain/src/staff.rs`):
 * only a superadmin changes the list, and it never loses its last active
 * superadmin, without whom nobody could change it again. Pure, so the console
 * and its tests share them; the writes are in `actions/staff.server.ts`.
 */

import { ADMIN_ROLES, type AdminRole } from './roles';

/** What the staff-list writes need of a row. */
export interface StaffRowState {
  role: AdminRole;
  isActive: boolean;
}

/** Lowercased and trimmed, or null when it isn't an email address (the CLI's check). */
export function normalizeStaffEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 255 || /\s/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return null;
  const domain = email.slice(at + 1);
  return domain.includes('.') ? email : null;
}

export function parseStaffRole(value: string): AdminRole | null {
  const role = value.trim().toLowerCase();
  return ADMIN_ROLES.includes(role as AdminRole) ? (role as AdminRole) : null;
}

/** Only a superadmin adds, changes or removes staff. */
export function mayChangeStaff(actorRole: AdminRole): boolean {
  return actorRole === 'superadmin';
}

/**
 * Whether a change leaves an active superadmin: `before` is the row being
 * changed (null when it is new), `staysSuperadmin` whether it is an active
 * superadmin afterwards, `activeSuperadmins` how many there are now.
 */
export function keepsASuperadmin(
  before: StaffRowState | null,
  staysSuperadmin: boolean,
  activeSuperadmins: number,
): boolean {
  const takesOneAway = !staysSuperadmin && before !== null && before.isActive && before.role === 'superadmin';
  return !takesOneAway || activeSuperadmins > 1;
}
