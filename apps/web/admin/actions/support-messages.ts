'use server';

import { requireAdmin } from '@/lib/auth';
import { listSupportMessages, type SupportMessageList } from '@/lib/support-data';

export async function fetchSupportMessages(
  orgId: string,
  before?: string,
): Promise<SupportMessageList> {
  await requireAdmin();
  return listSupportMessages(orgId, { before, limit: 50 });
}
