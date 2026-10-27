/**
 * Realtime topics → query keys. Same stance as the platform's WeldHR entries
 * in `apps/web/platform/lib/realtime/sync-map.ts`: the events carry ids and
 * status only, so every `hr_*` topic simply refetches the mounted WeldHR
 * queries.
 */

import { inv, type EntitySyncMap } from '@weldsuite/realtime/react';
import { weldhrKeys } from './query-client';

const refreshWeldHr = inv(weldhrKeys.all);

export const appSyncMap: EntitySyncMap = {
  hr_employee: refreshWeldHr,
  hr_checklist: refreshWeldHr,
  hr_attendance: refreshWeldHr,
  hr_leave_request: refreshWeldHr,
  hr_shift_request: refreshWeldHr,
  hr_open_shift: refreshWeldHr,
  hr_announcement: refreshWeldHr,
  hr_declaration: refreshWeldHr,
  hr_absence: refreshWeldHr,
  hr_coaching_log: refreshWeldHr,
  hr_evaluation: refreshWeldHr,
  hr_milestone: refreshWeldHr,
  hr_payslip: refreshWeldHr,
};
