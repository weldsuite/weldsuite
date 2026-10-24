/** Query-string builder for `GET /desk/conversations`. React-free so it is unit-testable. */

import type { DeskConversationFilters, DeskConversationSort } from '@/types/desk';

export function buildConversationQuery(
  filters: DeskConversationFilters,
  sort?: DeskConversationSort,
  cursor?: string,
): string {
  const params = new URLSearchParams();
  if (filters.state) params.set('state', filters.state);
  if (filters.assigneeId) params.set('assigneeId', filters.assigneeId);
  if (filters.unassigned) params.set('unassigned', 'true');
  if (filters.channel) params.set('channel', filters.channel);
  const q = filters.q?.trim();
  if (q) params.set('q', q);
  if (sort) params.set('sort', sort);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
