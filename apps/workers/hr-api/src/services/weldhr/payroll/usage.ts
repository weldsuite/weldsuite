/**
 * The billing ledger: one `payroll_usage_events` row per final payslip in the
 * master DB. `(workspace_id, payslip_id)` is unique, so approving twice or a
 * retry after a timeout never counts a payslip twice.
 */

import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { UsageEventInput } from './deps';

export async function writeUsageEvents(master: Pick<MasterDatabase, 'insert'>, events: UsageEventInput[]): Promise<void> {
  if (events.length === 0) return;
  await master
    .insert(masterSchema.payrollUsageEvents)
    .values(events.map((event) => ({ id: generateId('pue'), ...event })))
    .onConflictDoNothing();
}
