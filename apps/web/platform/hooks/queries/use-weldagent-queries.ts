
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client/client';
import { useAppApi } from '@/lib/api/use-app-api';

// =============================================================================
// Query Keys
// =============================================================================

export const weldagentKeys = {
  all: ['weldagent'] as const,
  conversations: () => [...weldagentKeys.all, 'conversations'] as const,
  conversationList: (agentId?: string | null) =>
    [...weldagentKeys.conversations(), 'list', agentId ?? 'all'] as const,
  conversationMessages: (id: string) => [...weldagentKeys.conversations(), id, 'messages'] as const,
  settings: () => [...weldagentKeys.all, 'settings'] as const,
  credits: () => [...weldagentKeys.all, 'credits'] as const,
  mentions: (query: string, type?: string) => [...weldagentKeys.all, 'mentions', query, type] as const,
};

// =============================================================================
// Types
// =============================================================================

export interface ConversationSummary {
  id: string;
  name: string;
  moduleKey: string | null;
  agentId?: string | null;
  isPinned: boolean;
  // Wire format: ISO strings (the API serializes timestamps to JSON).
  lastMessageAt: string | null;
  messageCount: number;
  createdAt: string;
}

export interface WeldAgentMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolInvocations?: unknown[];
  /** `kind: 'approval_outcome'` marks a note posted after an approval, not a turn reply. */
  metadata?: Record<string, unknown> | null;
  formState?: {
    formId?: string;
    formType?: string;
    values?: Record<string, unknown>;
    submitted?: boolean;
  };
  createdAt: string;
}

export interface WeldAgentUserSettings {
  id: string;
  userId: string;
  preferredModel: string;
  fallbackModel: string | null;
  temperature: number;
  maxTokens: number;
  showToolCalls: boolean;
  autoSendSuggestions: boolean;
  saveConversationHistory: boolean;
  appPermissions: Record<string, boolean>;
}
// =============================================================================
// Conversations  (app-api: /api/weldagent/*)
// =============================================================================

// Lists the current user's saved chats for the home sidebar's "Recent" /
// "Pinned" groups. Backed by app-api `GET /api/weldagent/conversations`.
// Pass `agentId` to scope to one workspace agent (Grok-bot style history), or
// `'none'` for personal assistant chats only.
export function useWeldAgentConversations(limit = 50, agentId?: string | null) {
  const { weldAgent } = useAppApi();
  return useQuery({
    queryKey: weldagentKeys.conversationList(agentId),
    queryFn: async (): Promise<ConversationSummary[]> => {
      const result = await weldAgent.listConversations(limit, {
        ...(agentId ? { agentId } : {}),
      });
      return (result.data || []) as unknown as ConversationSummary[];
    },
  });
}

/**
 * One conversation by id (e.g. from a notification link). Resolves to null
 * when it is gone or not the current user's.
 */
export function useWeldAgentConversation(conversationId: string | null) {
  const { weldAgent } = useAppApi();
  return useQuery({
    queryKey: [...weldagentKeys.conversations(), 'one', conversationId ?? ''] as const,
    queryFn: async (): Promise<ConversationSummary | null> => {
      if (!conversationId) return null;
      try {
        const result = await weldAgent.getConversation(conversationId);
        return (result.data ?? null) as unknown as ConversationSummary | null;
      } catch (err) {
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
    },
    enabled: !!conversationId,
    retry: false,
  });
}

export function useWeldAgentConversationMessages(
  conversationId: string | null,
  limit = 100,
  opts?: { refetchInterval?: number | false },
) {
  const { weldAgent } = useAppApi();
  return useQuery({
    queryKey: weldagentKeys.conversationMessages(conversationId || ''),
    queryFn: async () => {
      if (!conversationId) return [];
      const result = await weldAgent.listMessages(conversationId, { limit });
      return (result.data || []) as unknown as WeldAgentMessage[];
    },
    enabled: !!conversationId,
    refetchInterval: opts?.refetchInterval,
  });
}

export function useCreateConversation() {
  const { weldAgent } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { name?: string; moduleKey?: string; agentId?: string }) => {
      const result = await weldAgent.createConversation(params);
      return result.data as unknown as ConversationSummary;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: weldagentKeys.conversations() });
      if (data?.agentId) {
        qc.invalidateQueries({ queryKey: weldagentKeys.conversationList(data.agentId) });
      }
    },
  });
}

export function useCompleteConversationTurn() {
  const { weldAgent } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      conversationId: string;
      content: string;
      agentId?: string;
      /** When true, block until the assistant reply is ready. Default: cloud async. */
      wait?: boolean;
      /** The user's IANA timezone, so the agent schedules in local time. */
      timezone?: string;
    }) => {
      const { conversationId, ...body } = params;
      const result = await weldAgent.completeTurn(conversationId, body);
      return result.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: weldagentKeys.conversationMessages(variables.conversationId),
      });
      qc.invalidateQueries({ queryKey: weldagentKeys.conversations() });
    },
  });
}

export function useSaveMessage() {
  const { weldAgent } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      conversationId: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      toolInvocations?: unknown[];
      formState?: unknown;
    }) => {
      const { conversationId, ...body } = params;
      const result = await weldAgent.saveMessage(conversationId, body);
      return result.data as unknown as WeldAgentMessage;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: weldagentKeys.conversationMessages(variables.conversationId) });
      qc.invalidateQueries({ queryKey: weldagentKeys.conversations() });
    },
  });
}

export function useUpdateConversation() {
  const { weldAgent } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { conversationId: string; name?: string; isPinned?: boolean }) => {
      const { conversationId, ...body } = params;
      const result = await weldAgent.updateConversation(conversationId, body);
      return result.data as unknown as ConversationSummary;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldagentKeys.conversations() });
    },
  });
}

export function useDeleteConversation() {
  const { weldAgent } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) => {
      await weldAgent.deleteConversation(conversationId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldagentKeys.conversations() });
    },
  });
}