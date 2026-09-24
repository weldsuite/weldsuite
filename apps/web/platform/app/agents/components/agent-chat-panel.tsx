'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, CheckCircle2, ChevronDown, Clock, Plus, XCircle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
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
import {
  useAgentApprovals,
  useDecideAgentApproval,
} from '@/hooks/queries/use-agent-parity-queries';
import { AgentSetupPicker } from './agent-setup-picker';

interface AgentChatPanelProps {
  agentId: string;
  agentName: string;
  needsSetup?: boolean;
}

const setupSeedPromises = new Map<string, Promise<string>>();

/** Background turns run in a durable workflow (10 min step budget). */
const REPLY_TIMEOUT_MS = 10 * 60_000;
/** After this long, reassure the user the agent is still on it. */
const STILL_WORKING_AFTER_MS = 30_000;

interface ToolInvocationView {
  toolName: string;
  state: 'call' | 'result' | 'error';
  result?: unknown;
}

function readToolInvocations(raw: unknown): ToolInvocationView[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (inv): inv is ToolInvocationView =>
      !!inv &&
      typeof inv === 'object' &&
      typeof (inv as ToolInvocationView).toolName === 'string' &&
      ((inv as ToolInvocationView).state === 'result' || (inv as ToolInvocationView).state === 'error'),
  );
}

function pendingApprovalId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { pendingApproval?: unknown; approvalId?: unknown };
  return r.pendingApproval === true && typeof r.approvalId === 'string' ? r.approvalId : null;
}

function isErrorResult(inv: ToolInvocationView): boolean {
  if (inv.state === 'error') return true;
  const r = inv.result as { error?: unknown } | null | undefined;
  return !!r && typeof r === 'object' && typeof r.error === 'string';
}

function humanizeTool(name: string): string {
  return name.replace(/_/g, ' ');
}

function ToolActivity({
  invocations,
  pendingIds,
  onDecide,
  deciding,
}: {
  invocations: ToolInvocationView[];
  pendingIds: Set<string>;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => void;
  deciding: boolean;
}) {
  const t = getTranslations('common').agents.detail.chat;
  if (invocations.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {invocations.map((inv, idx) => {
        const tool = humanizeTool(inv.toolName);
        const approvalId = pendingApprovalId(inv.result);
        if (approvalId) {
          const stillPending = pendingIds.has(approvalId);
          return (
            <div
              key={`${inv.toolName}-${idx}`}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[13px]"
            >
              <Clock className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <span className="flex-1 min-w-0">
                {(stillPending ? t.toolPending : t.toolDecided).replace('{tool}', tool)}
              </span>
              {stillPending && (
                <span className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={deciding}
                    className="rounded-full bg-foreground px-3 py-1 text-[12px] font-medium text-background disabled:opacity-50"
                    onClick={() => onDecide(approvalId, 'approved')}
                  >
                    {t.approve}
                  </button>
                  <button
                    type="button"
                    disabled={deciding}
                    className="rounded-full border px-3 py-1 text-[12px] font-medium disabled:opacity-50"
                    onClick={() => onDecide(approvalId, 'rejected')}
                  >
                    {t.reject}
                  </button>
                </span>
              )}
            </div>
          );
        }
        const failed = isErrorResult(inv);
        return (
          <div
            key={`${inv.toolName}-${idx}`}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
          >
            {failed ? (
              <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
            )}
            <span>{(failed ? t.toolFailed : t.toolRan).replace('{tool}', tool)}</span>
          </div>
        );
      })}
    </div>
  );
}

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
  const { data: pendingApprovals = [] } = useAgentApprovals(agentId);
  const decideApproval = useDecideAgentApproval(agentId);
  const pendingApprovalIds = useMemo(
    () => new Set(pendingApprovals.map((a) => a.id)),
    [pendingApprovals],
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [awaitingReplyAfterId, setAwaitingReplyAfterId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [introLine, setIntroLine] = useState<string | null>(null);
  const [introComplete, setIntroComplete] = useState(false);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [stillWorking, setStillWorking] = useState(false);
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

  // Reset per-agent state only when switching agents — not on mount, where it
  // would run after (and undo) the effect below that opens the latest thread.
  const previousAgentId = useRef(agentId);
  useEffect(() => {
    if (previousAgentId.current === agentId) return;
    previousAgentId.current = agentId;
    setActiveId(null);
    setInput('');
    setPendingUser(null);
    setAwaitingReplyAfterId(null);
    setSendError(null);
    setSeeding(false);
    setIntroLine(null);
    setIntroComplete(false);
    setPickerDismissed(false);
    setStillWorking(false);
  }, [agentId]);

  // Open the most recent thread when none is selected. A freshly created
  // conversation may not be in the (refetching) list yet — keep it selected.
  useEffect(() => {
    if (activeId) return;
    if (conversations[0]) setActiveId(conversations[0].id);
  }, [conversations, activeId]);

  const awaitingReply = Boolean(awaitingReplyAfterId);
  const { data: messages = [], isLoading: loadingMessages } = useWeldAgentConversationMessages(
    activeId,
    100,
    // Poll while a reply is being generated, or while an approved action's
    // outcome may still be landing in the thread.
    { refetchInterval: awaitingReply ? 1500 : decideApproval.isPending ? 1000 : false },
  );

  // Clear local pending state once the cloud reply lands in the thread.
  useEffect(() => {
    if (!awaitingReplyAfterId) return;
    const userIdx = messages.findIndex((m) => m.id === awaitingReplyAfterId);
    if (userIdx < 0) return;
    // Persisted user message is in — drop optimistic bubble.
    setPendingUser(null);
    // Approval outcome notes can land in the thread meanwhile — they are not
    // the reply to this turn.
    const reply = messages
      .slice(userIdx + 1)
      .find((m) => m.role === 'assistant' && m.metadata?.kind !== 'approval_outcome');
    if (!reply) return;
    setAwaitingReplyAfterId(null);
    if (needsSetup) {
      void qc.invalidateQueries({ queryKey: ['workspace-agents'] });
    }
  }, [messages, awaitingReplyAfterId, needsSetup, qc]);

  // Never leave the typing indicator stuck if the cloud finish never lands.
  useEffect(() => {
    setStillWorking(false);
    if (!awaitingReplyAfterId) return;
    const reassure = window.setTimeout(() => setStillWorking(true), STILL_WORKING_AFTER_MS);
    const timer = window.setTimeout(() => {
      setAwaitingReplyAfterId(null);
      setPendingUser(null);
      setStillWorking(false);
      setSendError(t.replyTimedOut);
      void qc.invalidateQueries({
        queryKey: weldagentKeys.conversationMessages(activeId || ''),
      });
    }, REPLY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(reassure);
      window.clearTimeout(timer);
    };
  }, [awaitingReplyAfterId, activeId, qc, t.replyTimedOut]);

  const handleDecide = useCallback(
    (approvalId: string, decision: 'approved' | 'rejected') => {
      setSendError(null);
      decideApproval.mutate(
        { id: approvalId, decision },
        { onError: () => setSendError(t.approvalFailed) },
      );
    },
    [decideApproval, t.approvalFailed],
  );

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
      if (!trimmed || completeTurn.isPending || awaitingReplyAfterId) return;

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
        // Setup interview waits for the reply so gateway/config errors surface
        // immediately instead of leaving an endless typing indicator.
        // Active agents stay async (cloud waitUntil) so long tool runs don't block.
        const result = await completeTurn.mutateAsync({
          conversationId,
          content: trimmed,
          agentId,
          wait: needsSetup,
        });

        if (result?.userMessage?.id && result.pending) {
          setAwaitingReplyAfterId(result.userMessage.id);
        }

        if (result?.assistantMessage && !result.pending) {
          setPendingUser(null);
          setAwaitingReplyAfterId(null);
          await qc.invalidateQueries({
            queryKey: weldagentKeys.conversationMessages(conversationId),
          });
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
      awaitingReplyAfterId,
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

  const canSend =
    Boolean(input.trim()) &&
    !completeTurn.isPending &&
    !awaitingReply &&
    !createConversation.isPending &&
    !seeding;
  const visibleMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const openConversation = (conversationId: string) => {
    if (conversationId === activeId || awaitingReply) return;
    setActiveId(conversationId);
    setPendingUser(null);
    setSendError(null);
  };
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
        <div className="flex items-center gap-3 shrink-0">
          {conversations.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
                  disabled={awaitingReply}
                >
                  {t.previousChats}
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
                {conversations.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    className={cn('flex flex-col items-start gap-0.5', c.id === activeId && 'bg-accent')}
                    onSelect={() => openConversation(c.id)}
                  >
                    <span className="w-full truncate text-[13px]">{c.name}</span>
                    {c.lastMessageAt && (
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(c.lastMessageAt).toLocaleString()}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button
            type="button"
            className="text-[13px] text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => void startNewChat()}
            disabled={createConversation.isPending || awaitingReply}
          >
            {t.newChat}
          </button>
        </div>
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
            visibleMessages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id}>{m.content}</UserBubble>
              ) : (
                <div key={m.id} className="animate-in fade-in duration-200">
                  <AssistantBubble>{m.content}</AssistantBubble>
                  <ToolActivity
                    invocations={readToolInvocations(m.toolInvocations)}
                    pendingIds={pendingApprovalIds}
                    onDecide={handleDecide}
                    deciding={decideApproval.isPending}
                  />
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
            <div className="min-h-[36px] flex flex-col items-start gap-1 animate-in fade-in duration-150">
              <AssistantBubble className="py-3">
                <TypingDots />
              </AssistantBubble>
              {stillWorking && (
                <p className="px-1 text-[12px] text-muted-foreground">{t.stillWorking}</p>
              )}
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
