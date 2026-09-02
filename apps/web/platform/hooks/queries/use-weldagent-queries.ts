
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

interface WeldAgentMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolInvocations?: unknown[];
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
// Pass `agentId` to scope to one workspace agent (Grok-bot style history).
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

export function useWeldAgentConversationMessages(conversationId: string | null, limit = 100) {
  const { weldAgent } = useAppApi();
  return useQuery({
    queryKey: weldagentKeys.conversationMessages(conversationId || ''),
    queryFn: async () => {
      if (!conversationId) return [];
      const result = await weldAgent.listMessages(conversationId, { limit });
      return (result.data || []) as unknown as WeldAgentMessage[];
    },
    enabled: !!conversationId,
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
    mutationFn: async (params: { conversationId: string; content: string; agentId?: string }) => {
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