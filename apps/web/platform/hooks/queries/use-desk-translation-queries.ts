/**
 * WeldDesk inbox translation (Global only; `desk-ai` hides it elsewhere).
 *
 *   POST /desk/conversations/:id/translate        the customer's messages in the agent's language
 *   POST /desk/conversations/:id/translate-reply  the agent's draft in the customer's language
 *
 * Translations are cached server-side (KV, 30 days), so asking again for
 * messages already translated costs nothing; the query key carries the
 * customer's message ids, so a new message fetches only itself.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { deskKeys, type DeskConversation, type DeskMessage } from '@/hooks/queries/use-desk-queries';

export interface DeskMessageTranslation {
  messageId: string;
  text: string;
}

export interface DeskConversationTranslation {
  /** The customer's language, as detected and stored on the conversation. */
  language: string | null;
  targetLocale: string;
  /** Empty when the customer already writes `targetLocale`. */
  translations: DeskMessageTranslation[];
}

export interface DeskReplyTranslationResult {
  text: string;
  sourceLocale: string | null;
  targetLocale: string;
}

/** What the reply route keeps in the message's internal metadata. */
export interface DeskReplyTranslation {
  original: string;
  sourceLocale: string;
  targetLocale: string;
}

/** `desk_conversations.language`, which the shared conversation type doesn't name yet. */
export function conversationLanguage(conversation: DeskConversation | null | undefined): string | null {
  const language = (conversation as (DeskConversation & { language?: string | null }) | null | undefined)?.language;
  return typeof language === 'string' && language ? language : null;
}

/** The customer's public messages with text: what the translate route translates by default. */
export function customerMessageIds(messages: DeskMessage[]): string[] {
  return messages
    .filter((m) => m.authorType === 'visitor' && m.kind === 'message' && !m.pending && m.body?.trim())
    .map((m) => m.id)
    .slice(-50);
}

/** The agent's words a sent message was translated from, if it was. */
export function messageTranslationMetadata(message: DeskMessage): DeskReplyTranslation | null {
  const value = message.metadata?.translation as Partial<DeskReplyTranslation> | undefined;
  if (!value || typeof value.original !== 'string' || typeof value.sourceLocale !== 'string') return null;
  return {
    original: value.original,
    sourceLocale: value.sourceLocale,
    targetLocale: typeof value.targetLocale === 'string' ? value.targetLocale : '',
  };
}

export const deskTranslationKeys = {
  all: ['desk-translations'] as const,
  conversation: (conversationId: string, targetLocale: string, messageIds: string[]) =>
    [...deskTranslationKeys.all, conversationId, targetLocale, messageIds.join(',')] as const,
};

export function useDeskConversationTranslations(
  conversationId: string,
  targetLocale: string,
  messageIds: string[],
  enabled: boolean,
) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();

  return useQuery({
    queryKey: deskTranslationKeys.conversation(conversationId, targetLocale, messageIds),
    enabled: enabled && messageIds.length > 0,
    // Server-side cached for 30 days; nothing changes under a given key.
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.post<{ data: DeskConversationTranslation }>(
        `/desk/conversations/${conversationId}/translate`,
        { targetLocale, messageIds },
      );
      // The detected language is stored on the conversation: show it right away.
      qc.setQueryData<{ data: DeskConversation }>(deskKeys.conversationDetail(conversationId), (old) =>
        old?.data ? { ...old, data: { ...old.data, language: res.data.language } } : old,
      );
      return res.data;
    },
  });
}

export function useTranslateDeskReply() {
  const { getClient } = useAppApiClient();

  return useMutation({
    mutationFn: async ({ conversationId, text, targetLocale }: { conversationId: string; text: string; targetLocale?: string }) => {
      const client = await getClient();
      const res = await client.post<{ data: DeskReplyTranslationResult }>(
        `/desk/conversations/${conversationId}/translate-reply`,
        { text, ...(targetLocale ? { targetLocale } : {}) },
      );
      return res.data;
    },
  });
}
