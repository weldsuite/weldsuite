import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { AgentChatInput } from '@/components/weldagent/agent-chat-input';
import { AssistantMessage, TypingIndicator, UserMessage } from '@/components/weldagent/chat/chat-message';
import { getTranslations } from '@/lib/i18n';
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
//
// The page uses the same composer as the home page (`AgentChatInput`), in the
// same spot, and the home page navigates here with a view transition: the
// composer stays put while the page cross-fades around it and the prompt rises
// into the thread (`.weldagent-composer-vt` / `.weldagent-prompt-vt` in
// globals.css).

const routeApi = getRouteApi('/new-chat');

/** Derive a short sidebar-friendly title from the first user message. */
function deriveTitle(firstMessage: string): string {
  const clean = firstMessage.replace(/\s+/g, ' ').trim();
  return clean.slice(0, 60) || getTranslations('weldsuiteHome').page.breadcrumbNewChat;
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
  const tHome = getTranslations('weldsuiteHome').page;
  const { prompt, conversation } = routeApi.useSearch();
  const navigate = useNavigate();

  const createConversation = useCreateConversation();
  const saveMessage = useSaveMessage();

  // A chat started here (a prompt handed off from the home page, or carried
  // through the create-conversation redirect) has no history to load.
  const [startedHere] = useState(() => !!prompt?.trim());
  // Set on this session's first send. From then on the in-memory thread is the
  // source of truth: every saved turn invalidates the messages query, and a
  // re-seed from that refetch would wipe a reply that is still streaming in.
  const [hasSent, setHasSent] = useState(false);

  // Existing conversation → load its history (once) to seed the chat.
  const historyQuery = useWeldAgentConversationMessages(startedHere ? null : (conversation ?? null));
  const loadedRows = historyQuery.data;
  const initialMessages = useMemo<ChatMessage[] | undefined>(() => {
    if (hasSent || !conversation || !loadedRows) return undefined;
    return loadedRows
      .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role !== 'system')
      .map((m) => ({ id: m.id, role: m.role, content: m.content }));
  }, [hasSent, conversation, loadedRows]);

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
  // The message being started while its conversation is created, shown in the
  // thread right away instead of an empty page.
  const [startingText, setStartingText] = useState<string | null>(null);
  const [createFailed, setCreateFailed] = useState(false);
  const startChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (conversationIdRef.current) {
        setHasSent(true);
        sendMessage(trimmed);
        return;
      }
      if (creatingRef.current) return;
      creatingRef.current = true;
      setStartingText(trimmed);
      setCreateFailed(false);
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
          setCreateFailed(true);
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

  // Until the first turn is in the thread, the message being started is shown
  // in its place — while the conversation is created and across the keyed
  // remount — so it never blinks out on the way from the home composer.
  const pendingPrompt = messages.length === 0 ? (startingText ?? (prompt?.trim() || null)) : null;
  const isCreating = pendingPrompt !== null && !createFailed;
  const isLoadingHistory = !startedHere && !!conversation && historyQuery.isPending;
  const isBusy = isSending || isCreating || isLoadingHistory;

  // Keep the latest message / thinking indicator in view.
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isSending, pendingPrompt]);

  const submit = useCallback(
    (text: string) => {
      if (!text.trim() || isBusy) return;
      startChat(text);
      setInput('');
    },
    [isBusy, startChat],
  );

  const retryStart = useCallback(() => {
    if (pendingPrompt) startChat(pendingPrompt);
  }, [pendingPrompt, startChat]);

  const isEmpty = messages.length === 0 && pendingPrompt === null;
  const lastMessage = messages.at(-1);

  let errorBanner: { message: string; onRetry: (() => void) | null } | null = null;
  if (createFailed) errorBanner = { message: t.error, onRetry: retryStart };
  else if (error) errorBanner = { message: error === 'credits' ? t.insufficientCredits : t.error, onRetry: error === 'generic' ? retry : null };

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
      <BreadcrumbHeader
        segments={[
          { label: 'WeldSuite', href: '/' },
          { label: tHome.breadcrumbNewChat, href: '/new-chat' },
        ]}
      />
      <ModuleContent className="flex flex-col overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto w-full max-w-3xl">
              {isEmpty && !isLoadingHistory && (
                <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                    <Sparkles className="h-6 w-6 text-primary" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">{t.emptyTitle}</p>
                    <p className="max-w-xs text-sm text-muted-foreground">{t.emptyBody}</p>
                  </div>
                </div>
              )}
              {!isEmpty && (
                <div className="space-y-6">
                  {pendingPrompt !== null ? (
                    <>
                      <div className="weldagent-prompt-vt">
                        <UserMessage>{pendingPrompt}</UserMessage>
                      </div>
                      {isCreating && <TypingIndicator />}
                    </>
                  ) : (
                    messages.map((m) => {
                      if (m.role === 'user') return <UserMessage key={m.id}>{m.content}</UserMessage>;
                      if (m.content) return <AssistantMessage key={m.id} content={m.content} />;
                      return isSending && m === lastMessage ? <TypingIndicator key={m.id} /> : null;
                    })
                  )}
                  <div ref={scrollEndRef} />
                </div>
              )}
            </div>
          </div>

          {/* Composer — same component and spot as the home page's. */}
          <div className="flex-shrink-0 px-6 pb-6">
            <div className="mx-auto w-full max-w-3xl">
              {errorBanner && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <span>{errorBanner.message}</span>
                  {errorBanner.onRetry && (
                    <button
                      type="button"
                      onClick={errorBanner.onRetry}
                      className="font-medium underline underline-offset-2 hover:opacity-80"
                    >
                      {t.retry}
                    </button>
                  )}
                </div>
              )}
              <div className="weldagent-composer-vt">
                <AgentChatInput value={input} onChange={setInput} onSubmit={submit} isSending={isBusy} autoFocus />
              </div>
            </div>
          </div>
        </div>
      </ModuleContent>
    </div>
  );
}
