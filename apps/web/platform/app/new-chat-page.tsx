import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Send, Sparkles } from 'lucide-react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useWeldAgentChat, type ChatMessage } from '@/hooks/queries/use-ai-chat';
import {
  useCreateConversation,
  useSaveMessage,
  useWeldAgentConversationMessages,
} from '@/hooks/queries/use-weldagent-queries';

// Full-page "Ask AI" chat, with persistence so every conversation shows up in
// the home sidebar's "Recent chats" list and can be re-opened.
//
// The home composer hands off the user's first prompt via the `prompt` search
// param. A brand-new chat has no `conversation` id yet: on the first send we
// create a conversation (app-api `POST /api/weldagent/conversations`) and
// navigate to `/new-chat?conversation={id}` — which remounts this component
// (keyed by conversation id, see the wrapper) BEFORE any streaming starts, so
// no in-flight stream is ever lost. From then on each turn is streamed through
// `/api/ai/chat/stream` and persisted via `POST .../messages`.

const routeApi = getRouteApi('/new-chat');

/** Derive a short sidebar-friendly title from the first user message. */
function deriveTitle(firstMessage: string): string {
  const clean = firstMessage.replace(/\s+/g, ' ').trim();
  return clean.slice(0, 60) || 'New Chat';
}

export default function ChatPage() {
  const { conversation } = routeApi.useSearch();
  // Key by conversation id so switching threads (or "New Chat") gives a fresh
  // hook state + reload. The id only appears AFTER the conversation is created
  // (pre-stream), so this remount is always safe.
  return <ChatSession key={conversation ?? 'new'} />;
}

function ChatSession() {
  const t = getTranslations('common').ai.chat;
  const { prompt, conversation } = routeApi.useSearch();
  const navigate = useNavigate();

  const createConversation = useCreateConversation();
  const saveMessage = useSaveMessage();

  // Existing conversation → load its history to seed the chat. A conversation
  // id that we created ourselves this mount starts with no server messages, so
  // loading it is harmless (returns []), but we still gate on `conversation`.
  const { data: loadedRows } = useWeldAgentConversationMessages(conversation ?? null);
  const initialMessages = useMemo<ChatMessage[] | undefined>(() => {
    if (!conversation || !loadedRows) return undefined;
    return loadedRows
      .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role !== 'system')
      .map((m) => ({ id: m.id, role: m.role, content: m.content }));
  }, [conversation, loadedRows]);

  // Where to persist. Set for an existing conversation; null for a fresh chat
  // until the first send creates one (via redirect — see `startChat`).
  const conversationIdRef = useRef<string | null>(conversation ?? null);

  const { messages, sendMessage, retry, isSending, error } = useWeldAgentChat({
    initialMessages,
    onUserMessage: async (content) => {
      const id = conversationIdRef.current;
      if (id) await saveMessage.mutateAsync({ conversationId: id, role: 'user', content });
    },
    onAssistantMessage: async (content) => {
      const id = conversationIdRef.current;
      if (id) await saveMessage.mutateAsync({ conversationId: id, role: 'assistant', content });
    },
  });

  // Start (or continue) the chat with `text`. When a conversation already
  // exists we stream in place; for a brand-new chat we create the conversation
  // first, then redirect (carrying the text as `prompt`) so the keyed remount
  // owns the actual send — the stream is never started before it has somewhere
  // to persist, and never interrupted by a mid-flight remount.
  const creatingRef = useRef(false);
  const startChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (conversationIdRef.current) {
        sendMessage(trimmed);
        return;
      }
      if (creatingRef.current) return;
      creatingRef.current = true;
      createConversation
        .mutateAsync({ name: deriveTitle(trimmed) })
        .then((conv) => {
          navigate({
            to: '/new-chat',
            search: { conversation: conv.id, prompt: trimmed },
            replace: true,
          });
        })
        .catch(() => {
          creatingRef.current = false;
        });
    },
    [createConversation, navigate, sendMessage],
  );

  const [input, setInput] = useState('');
  const scrollEndRef = useRef<HTMLDivElement>(null);

  // Auto-send the prompt handed off from the home page (or carried through the
  // create-conversation redirect), exactly once per mount.
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    const initial = prompt?.trim();
    if (!initial) return;
    bootstrappedRef.current = true;
    startChat(initial);
    // Once we're in a conversation the prompt has been consumed — strip it so a
    // refresh won't re-send. (No conversation yet → the redirect handles it.)
    if (conversation) {
      navigate({ to: '/new-chat', search: { conversation, prompt: undefined }, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, conversation]);

  // Keep the latest message / thinking indicator in view.
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isSending]);

  const submit = useCallback(() => {
    if (!input.trim() || isSending) return;
    startChat(input);
    setInput('');
  }, [input, isSending, startChat]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
      <BreadcrumbHeader
        segments={[
          { label: 'WeldSuite', href: '/' },
          { label: 'New Chat', href: '/new-chat' },
        ]}
      />
      <ModuleContent className="flex flex-col overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto w-full max-w-3xl">
              {isEmpty && !isSending ? (
                <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                    <Sparkles className="h-6 w-6 text-primary" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">{t.emptyTitle}</p>
                    <p className="max-w-xs text-sm text-muted-foreground">{t.emptyBody}</p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
                    >
                      <div
                        className={cn(
                          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm',
                          m.role === 'user'
                            ? 'bg-primary text-primary-foreground rounded-br-sm'
                            : 'bg-muted text-foreground rounded-bl-sm',
                        )}
                      >
                        {m.role === 'assistant' && !m.content && isSending ? (
                          <span className="flex items-center gap-2 text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t.thinking}
                          </span>
                        ) : (
                          m.content
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={scrollEndRef} />
                </div>
              )}
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div className="mx-auto mb-2 flex w-full max-w-3xl items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <span>{error === 'credits' ? t.insufficientCredits : t.error}</span>
              {error === 'generic' && (
                <button
                  type="button"
                  onClick={retry}
                  className="font-medium underline underline-offset-2 hover:opacity-80"
                >
                  {t.retry}
                </button>
              )}
            </div>
          )}

          {/* Composer */}
          <div className="flex-shrink-0 px-6 pb-6">
            <div className="mx-auto w-full max-w-3xl">
              <div className="flex items-end gap-2">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t.placeholder}
                  rows={1}
                  autoFocus
                  className="max-h-40 min-h-[44px] resize-none"
                  disabled={isSending}
                />
                <Button
                  size="sm"
                  className="h-11 w-11 flex-shrink-0 p-0"
                  onClick={submit}
                  disabled={!input.trim() || isSending}
                  aria-label={t.send}
                >
                  {isSending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </ModuleContent>
    </div>
  );
}
