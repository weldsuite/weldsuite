import 'server-only';

import type { AdminIdentity } from './auth';
import { callBillingWorker, type WorkerResult } from './billing-worker';
import type { AdminPartnerDetail, AdminPartnerListRow } from './partners';

/**
 * Reads for the partner screens, through the billing worker's admin API
 * (`/api/internal/admin/partners`). A failure comes back as a result, never a
 * throw, so the page can show "worker not configured" or the worker's message.
 */

export function listPartners(identity: AdminIdentity): Promise<WorkerResult<AdminPartnerListRow[]>> {
  return callBillingWorker<AdminPartnerListRow[]>('GET', '/partners', { identity });
}

export function getPartnerDetail(identity: AdminIdentity, partnerId: string): Promise<WorkerResult<AdminPartnerDetail>> {
  return callBillingWorker<AdminPartnerDetail>('GET', `/partners/${encodeURIComponent(partnerId)}`, { identity });
}
