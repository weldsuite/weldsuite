/**
 * WeldHR workspace settings: what employees may do for themselves in My HR.
 */

import { eq } from 'drizzle-orm';
import type { HrSettings } from '@weldsuite/db/schema';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const s = schema.hrSettings;

/** The singleton settings row, created with the defaults (everything on) on first read. */
export async function loadHrSettings(db: Database): Promise<HrSettings> {
  const [row] = await db.select().from(s).limit(1);
  if (row) return row;
  const [created] = await db.insert(s).values({ id: generateId('hrset') }).returning();
  return created!;
}

export async function updateHrSettings(
  db: Database,
  input: Partial<Pick<HrSettings, 'employeeSelfClockIn' | 'employeeLeaveRequests' | 'employeeDeclarations'>>,
): Promise<HrSettings> {
  const current = await loadHrSettings(db);
  const [row] = await db.update(s).set({ ...input, updatedAt: new Date() }).where(eq(s.id, current.id)).returning();
  return row!;
}
