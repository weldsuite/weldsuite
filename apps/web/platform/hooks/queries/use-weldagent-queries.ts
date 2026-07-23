
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// Query Keys
// =============================================================================

export const weldagentKeys = {
  all: ['weldagent'] as const,
  conversations: () => [...weldagentKeys.all, 'conversations'] as const,
  conversationList: () => [...weldagentKeys.conversations(), 'list'] as const,
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
  toolInvocations?: any[];
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

interface MentionSearchResult {
  id: string;
  type: string;
  label: string;
  description?: string;
  icon: string;
}

// =============================================================================
// Conversations  (app-api: /api/weldagent/*)
// =============================================================================

// Lists the current user's saved chats for the home sidebar's "Recent" /
// "Pinned" groups. Backed by app-api `GET /api/weldagent/conversations`.
export function useWeldAgentConversations(limit = 50) {
  const { weldAgent } = useAppApi();
  return useQuery({
    queryKey: weldagentKeys.conversationList(),
    queryFn: async (): Promise<ConversationSummary[]> => {
      const result = await weldAgent.listConversations(limit);
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
    mutationFn: async (params: { name?: string; moduleKey?: string }) => {
      const result = await weldAgent.createConversation(params);
      return result.data as unknown as ConversationSummary;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldagentKeys.conversationList() });
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
      toolInvocations?: any[];
      formState?: any;
    }) => {
      const { conversationId, ...body } = params;
      const result = await weldAgent.saveMessage(conversationId, body);
      return result.data as unknown as WeldAgentMessage;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: weldagentKeys.conversationMessages(variables.conversationId) });
      qc.invalidateQueries({ queryKey: weldagentKeys.conversationList() });
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
      qc.invalidateQueries({ queryKey: weldagentKeys.conversationList() });
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
      qc.invalidateQueries({ queryKey: weldagentKeys.conversationList() });
    },
  });
}

// =============================================================================
// Settings  (app-api: /api/weldagent/settings)
// =============================================================================

function useWeldAgentSettings() {
  const { weldAgent } = useAppApi();
  return useQuery({
    queryKey: weldagentKeys.settings(),
    queryFn: async () => {
      const result = await weldAgent.getSettings();
      return result.data as unknown as WeldAgentUserSettings;
    },
  });
}

function useSaveWeldAgentSettings() {
  const { weldAgent } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<Omit<WeldAgentUserSettings, 'id' | 'userId'>>) => {
      const result = await weldAgent.saveSettings(data);
      return result.data as unknown as WeldAgentUserSettings;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldagentKeys.settings() });
    },
  });
}

// =============================================================================
// Mentions  (app-api: /api/weldagent/mentions/search)
// =============================================================================

function useWeldAgentMentionSearch(query: string, type?: string, limit = 5) {
  const { weldAgent } = useAppApi();
  return useQuery({
    queryKey: weldagentKeys.mentions(query, type),
    queryFn: async () => {
      const result = await weldAgent.searchMentions({ query, type, limit });
      return (result.data || []) as MentionSearchResult[];
    },
    enabled: query.length >= 1,
  });
}

// =============================================================================
// Credits (convenience wrapper around the canonical /credits/balance surface)
// =============================================================================

function useWeldAgentCredits() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldagentKeys.credits(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any }>('/credits/balance');
      return result.data;
    },
  });
}
