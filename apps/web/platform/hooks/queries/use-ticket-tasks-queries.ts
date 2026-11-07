/**
 * WeldFlow tasks created from a WeldDesk ticket (WeldSuite task 1223).
 *
 * A task made from a conversation stores `sourceType: 'desk_conversation'`
 * and the conversation's id (flow-api `POST /api/tasks`). The ticket's
 * details panel lists them (`GET /api/tasks?sourceType&sourceId`), and the
 * task links back to its ticket (desk-api `GET /api/desk/conversations/:id`).
 */

import { useQuery } from '@tanstack/react-query';
import type { ListResponse } from '@weldsuite/app-api-client/types';
import type { TaskRow } from '@weldsuite/app-api-client/domains/tasks';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';

export const TICKET_TASK_SOURCE = 'desk_conversation' as const;

/** A task row as the list answers it, with its enriched assignee. */
export type TicketTask = TaskRow & {
  assignee?: { id: string; name: string | null; email: string | null; avatar: string | null } | null;
};

export const ticketTaskKeys = {
  all: ['ticket-tasks'] as const,
  forConversation: (conversationId: string) => [...ticketTaskKeys.all, 'conversation', conversationId] as const,
  sourceTicket: (conversationId: string) => [...ticketTaskKeys.all, 'source-ticket', conversationId] as const,
};

/** The tasks created from this conversation, oldest first. */
export function useTicketTasks(conversationId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: ticketTaskKeys.forConversation(conversationId),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({
        sourceType: TICKET_TASK_SOURCE,
        sourceId: conversationId,
        sortField: 'createdAt',
        limit: '50',
      });
      const res = await client.get<ListResponse<TicketTask>>(`/tasks?${params.toString()}`);
      return res.data;
    },
    enabled: !!conversationId && enabled,
    // No `tasks:read`: the section stays hidden, no retries.
    retry: false,
  });
}

/**
 * The ticket a task came from, for "From ticket #N". Errors (no
 * `conversations:read`, a deleted ticket) answer nothing and are not retried:
 * the link is just left out.
 */
export function useTaskSourceTicket(sourceType: string | null | undefined, sourceId: string | null | undefined) {
  const { getClient } = useAppApiClient();
  const conversationId = sourceType === TICKET_TASK_SOURCE && sourceId ? sourceId : '';
  return useQuery({
    queryKey: ticketTaskKeys.sourceTicket(conversationId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskConversation }>(`/desk/conversations/${conversationId}`);
      return res.data;
    },
    enabled: !!conversationId,
    retry: false,
    staleTime: 60_000,
  });
}
