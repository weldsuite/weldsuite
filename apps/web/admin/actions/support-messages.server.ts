import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { listSupportMessages, type SupportMessageList } from '@/lib/support-data';
import type { JsonValue } from './workspaces';

/**
 * `SupportMessageList` with each message's `metadata` (a jsonb column) typed as
 * JSON, so the page can cross a server function.
 */
type SupportMessagePage = Omit<SupportMessageList, 'messages'> & {
  messages: Array<
    Omit<SupportMessageList['messages'][number], 'metadata'> & { metadata: { [key: string]: JsonValue } | null }
  >;
};

export async function fetchSupportMessages(
  orgId: string,
  before?: string,
): Promise<SupportMessagePage> {
  await requireAdmin();
  return listSupportMessages(orgId, { before, limit: 50 }) as Promise<SupportMessagePage>;
}
