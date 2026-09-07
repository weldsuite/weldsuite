'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Plus } from 'lucide-react';
import { useUser } from '@clerk/clerk-react';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { useAppApi } from '@/lib/api/use-app-api';
import { useQueryClient } from '@tanstack/react-query';
import {
  useWeldAgentConversations,
  useWeldAgentConversationMessages,
  useCreateConversation,
  useCompleteConversationTurn,
  weldagentKeys,
} from '@/hooks/queries/use-weldagent-queries';
import { AgentSetupPicker } from './agent-setup-picker';

interface AgentChatPanelProps {
  agentId: string;
  agentName: string;
  needsSetup?: boolean;
}

const setupSeedPromises = new Map<string, Promise<string>>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-1', className)} aria-hidden>
      <span className="h-1.5 w-1.5 rounded-full bg-foreground/35 animate-bounce [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-foreground/35 animate-bounce [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-foreground/35 animate-bounce" />
    </span>
  );
}

function formatTodayStamp() {
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date());
  return `Today ${time}`;
}

function AssistantBubble({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'inline-block max-w-[min(100%,420px)] rounded-[22px] bg-[#ececf1] dark:bg-muted px-4 py-2.5',
        'text-[15px] leading-relaxed text-foreground whitespace-pre-wrap',
        className,
      )}
    >
      {children}
    </div>
  );
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="inline-block max-w-[min(100%,420px)] rounded-[22px] bg-[#ececf1] dark:bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
        {children}
      </div>
    </div>
  );
}

export function AgentChatPanel({ agentId, agentName, needsSetup = false }: AgentChatPanelProps) {
  const t = getTranslations('common').agents.detail.chat;
  const setupT = getTranslations('common').agents.detail.setup;
  const { user, isLoaded: userLoaded } = useUser();
  const firstName = user?.firstName || user?.fullName?.split(' ')[0] || '';
  const { weldAgent } = useAppApi();
  const qc = useQueryClient();
  const { data: conversations = [], isLoading: loadingList } = useWeldAgentConversations(50, agentId);
  const createConversation = useCreateConversation();
  const completeTurn = useCompleteConversationTurn();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [awaitingReplyAfterId, setAwaitingReplyAfterId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [introLine, setIntroLine] = useState<string | null>(null);
  const [introComplete, setIntroComplete] = useState(false);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const greeting = useMemo(
    () =>
      firstName
        ? setupT.greetingNamed.replace('{name}', firstName)
        : setupT.greeting,
    [firstName, setupT.greeting, setupT.greetingNamed],
  );

  const dateStamp = useMemo(() => formatTodayStamp(), []);

  useEffect(() => {
    if (activeId && conversations.some((c) => c.id === activeId)) return;
    setActiveId(conversations[0]?.id ?? null);
  }, [conversations, activeId]);

  useEffect(() => {
    setActiveId(null);
    setInput('');
    setPendingUser(null);
    setAwaitingReplyAfterId(null);
    setSendError(null);
    setSeeding(false);
    setIntroLine(null);
    setIntroComplete(false);
    setPickerDismissed(false);
  }, [agentId]);

  const awaitingReply = Boolean(awaitingReplyAfterId);
  const { data: messages = [], isLoading: loadingMessages } = useWeldAgentConversationMessages(
    activeId,
    100,
    { refetchInterval: awaitingReply ? 1200 : false },
  );

  // Clear local pending state once the cloud reply lands in the thread.
  useEffect(() => {
    if (!awaitingReplyAfterId) return;
    const userIdx = messages.findIndex((m) => m.id === awaitingReplyAfterId);
    if (userIdx < 0) return;
    // Persisted user message is in — drop optimistic bubble.
    setPendingUser(null);
    const reply = messages.slice(userIdx + 1).find((m) => m.role === 'assistant');
    if (!reply) return;
    setAwaitingReplyAfterId(null);
    if (needsSetup) {
      void qc.invalidateQueries({ queryKey: ['workspace-agents'] });
    }
  }, [messages, awaitingReplyAfterId, needsSetup, qc]);

  const hasUserMessage = messages.some((m) => m.role === 'user') || !!pendingUser;
  const isWaiting = awaitingReply || completeTurn.isPending;
  const showSetupPicker =
    needsSetup && introComplete && !hasUserMessage && !isWaiting && !seeding && !pickerDismissed;

  useEffect(() => {
    if (!needsSetup || loadingList) return;
    if (!userLoaded) return;
    if (activeId && loadingMessages) return;

    if (activeId && messages.length > 0) {
      setIntroComplete(true);
      setIntroLine(null);
      setSeeding(false);
      return;
    }

    let cancelled = false;

    setSeeding(true);
    setIntroComplete(false);

    const seedPromise =
      setupSeedPromises.get(agentId) ??
      (async () => {
        let conversationId = activeId ?? conversations[0]?.id ?? null;
        if (!conversationId) {
          const conv = await createConversation.mutateAsync({
            name: setupT.chatName,
            agentId,
          });
          conversationId = conv.id;
        }

        const existing = await weldAgent.listMessages(conversationId, { limit: 20 });
        if ((existing.data?.length ?? 0) === 0) {
          await weldAgent.saveMessage(conversationId, {
            role: 'assistant',
            content: greeting,
          });
        }
        return conversationId;
      })();

    if (!setupSeedPromises.has(agentId)) {
      setupSeedPromises.set(agentId, seedPromise);
    }

    void (async () => {
      try {
        const conversationId = await seedPromise;
        if (cancelled) return;
        setActiveId(conversationId);

        await sleep(250);
        if (cancelled) return;
        setIntroLine(greeting);

        await qc.invalidateQueries({
          queryKey: weldagentKeys.conversationMessages(conversationId),
        });
        await qc.invalidateQueries({ queryKey: weldagentKeys.conversationList(agentId) });
        setIntroLine(null);
        setIntroComplete(true);
      } catch {
        setupSeedPromises.delete(agentId);
        if (!cancelled) setIntroComplete(false);
      } finally {
        if (!cancelled) setSeeding(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    needsSetup,
    loadingList,
    userLoaded,
    loadingMessages,
    activeId,
    messages.length,
    conversations,
    agentId,
    createConversation,
    weldAgent,
    qc,
    setupT.chatName,
    greeting,
  ]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, introLine, pendingUser, isWaiting, showSetupPicker]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const startNewChat = useCallback(async () => {
    setupSeedPromises.delete(agentId);
    setIntroLine(null);
    setIntroComplete(false);
    setPickerDismissed(false);
    setAwaitingReplyAfterId(null);
    const conv = await createConversation.mutateAsync({
      name: needsSetup ? setupT.chatName : t.newChatName,
      agentId,
    });
    setActiveId(conv.id);
    setInput('');
    setPendingUser(null);
    setSendError(null);
  }, [agentId, createConversation, needsSetup, setupT.chatName, t.newChatName]);

  const sendContent = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || completeTurn.isPending) return;

      let conversationId = activeId;
      if (!conversationId) {
        const conv = await createConversation.mutateAsync({
          name: needsSetup ? setupT.chatName : t.newChatName,
          agentId,
        });
        conversationId = conv.id;
        setActiveId(conv.id);
      }

      setInput('');
      setPendingUser(trimmed);
      setSendError(null);

      try {
        // Default async: Worker accepts the user message and generates in the cloud.
        const result = await completeTurn.mutateAsync({
          conversationId,
          content: trimmed,
          agentId,
        });

        if (result?.userMessage?.id) {
          setAwaitingReplyAfterId(result.userMessage.id);
        }

        if (result?.assistantMessage && !result.pending) {
          setPendingUser(null);
          setAwaitingReplyAfterId(null);
          if (needsSetup) {
            await qc.invalidateQueries({ queryKey: ['workspace-agents'] });
          }
        }
      } catch (err) {
        const msg =
          err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string'
            ? (err as { message: string }).message
            : t.sendFailed;
        setSendError(msg || t.sendFailed);
        setPendingUser(null);
        setAwaitingReplyAfterId(null);
      }
    },
    [
      activeId,
      agentId,
      completeTurn,
      createConversation,
      needsSetup,
      qc,
      setupT.chatName,
      t.newChatName,
      t.sendFailed,
    ],
  );

  const handleSend = useCallback(async () => {
    await sendContent(input);
  }, [input, sendContent]);

  const canSend = Boolean(input.trim()) && !completeTurn.isPending && !createConversation.isPending && !seeding;
  const showEmpty =
    !needsSetup && !loadingMessages && !seeding && messages.length === 0 && !introLine && !pendingUser;
  const hidePersistedWhileRevealing = seeding && !!introLine;
  const showTyping = (seeding && !introLine) || isWaiting;

  const composerPlaceholder = needsSetup
    ? setupT.composerPlaceholder.replace('{name}', agentName)
    : t.inputPlaceholder.replace('{name}', agentName);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f7f7f8] dark:bg-background">
      <div className="px-4 py-3 shrink-0 flex items-center justify-between gap-2">
        <span className="truncate text-[15px] font-medium text-foreground">{agentName}</span>
        <button
          type="button"
          className="text-[13px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          onClick={() => void startNewChat()}
          disabled={createConversation.isPending}
        >
          {t.newChat}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4">
        <div className="max-w-2xl mx-auto py-2 space-y-4 pb-4">
          {(messages.length > 0 || introLine || needsSetup) && (
            <p className="text-center text-[12px] text-muted-foreground/70 pt-2 pb-1">{dateStamp}</p>
          )}

          {showEmpty && (
            <div className="text-center py-16 space-y-1">
              <p className="text-[15px] font-medium">{t.emptyTitle.replace('{name}', agentName)}</p>
              <p className="text-[13px] text-muted-foreground">{t.emptyHint}</p>
            </div>
          )}

          {!hidePersistedWhileRevealing &&
            messages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id}>{m.content}</UserBubble>
              ) : (
                <div key={m.id} className="animate-in fade-in duration-200">
                  <AssistantBubble>{m.content}</AssistantBubble>
                </div>
              ),
            )}

          {introLine && (
            <div className="animate-in fade-in slide-in-from-bottom-1 duration-300">
              <AssistantBubble>{introLine}</AssistantBubble>
            </div>
          )}

          {showSetupPicker && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <AgentSetupPicker
                disabled={isWaiting}
                onDismiss={() => setPickerDismissed(true)}
                onSubmit={({ message }) => void sendContent(message)}
              />
            </div>
          )}

          {pendingUser && (
            <div className="animate-in fade-in duration-150">
              <UserBubble>{pendingUser}</UserBubble>
            </div>
          )}

          {showTyping && (
            <div className="min-h-[36px] flex items-center animate-in fade-in duration-150">
              <AssistantBubble className="py-3">
                <TypingDots />
              </AssistantBubble>
            </div>
          )}

          {sendError && (
            <p className="text-sm text-destructive text-center animate-in fade-in">{sendError}</p>
          )}
          <div ref={scrollEndRef} />
        </div>
      </div>

      <div className="shrink-0 px-3 sm:px-4 pb-4 pt-1">
        <div className="max-w-2xl mx-auto">
          <div
            className={cn(
              'flex items-end gap-2 rounded-full border border-black/5 dark:border-white/10',
              'bg-white dark:bg-muted/40 shadow-[0_2px_12px_rgba(0,0,0,0.06)]',
              'dark:shadow-[0_2px_16px_rgba(0,0,0,0.35)]',
              'pl-2 pr-2 py-2',
            )}
          >
            <button
              type="button"
              className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted transition-colors"
              aria-label="Add"
              tabIndex={-1}
            >
              <Plus className="h-5 w-5" strokeWidth={1.75} />
            </button>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={composerPlaceholder}
              rows={1}
              disabled={seeding}
              className="flex-1 min-w-0 resize-none bg-transparent py-2 text-[15px] leading-relaxed placeholder:text-muted-foreground/55 focus:outline-none disabled:opacity-60 max-h-[160px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) void handleSend();
                }
              }}
            />
            <button
              type="button"
              className={cn(
                'mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors',
                canSend
                  ? 'bg-foreground text-background'
                  : 'bg-foreground/15 text-background/80 dark:bg-foreground/25',
              )}
              disabled={!canSend}
              onClick={() => void handleSend()}
              aria-label="Send"
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
