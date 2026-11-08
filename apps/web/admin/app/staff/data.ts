import '@tanstack/react-start/server-only';

import { asc, desc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { mayChangeStaff } from '@/lib/staff';

const { adminUsers } = masterSchema;

/** The staff list: everyone who was ever on it, the active first. */
export async function loadStaffPage() {
  const identity = await requireAdmin();
  const rows = await getMasterDb()
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.name,
      role: adminUsers.role,
      isActive: adminUsers.isActive,
      invitedBy: adminUsers.invitedBy,
      invitedAt: adminUsers.invitedAt,
      lastLoginAt: adminUsers.lastLoginAt,
    })
    .from(adminUsers)
    .orderBy(desc(adminUsers.isActive), asc(adminUsers.email));

  return {
    staff: rows.map((row) => ({
      ...row,
      invitedAt: row.invitedAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    })),
    me: identity.email,
    canWrite: mayChangeStaff(identity.role),
  };
}

export type StaffPageData = Awaited<ReturnType<typeof loadStaffPage>>;
export type StaffRow = StaffPageData['staff'][number];
