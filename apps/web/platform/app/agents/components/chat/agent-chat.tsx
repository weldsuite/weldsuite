'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  useCompleteConversationTurn,
  useLoadOlderMessages,
  useWeldAgentConversationMessages,
  weldagentKeys,
  type WeldAgentMessage,
} from '@/hooks/queries/use-weldagent-queries';
import { agentKeys } from '@/hooks/queries/use-agent-queries';
import {
  agentParityKeys,
  useAgentApprovals,
  useDecidedApprovals,
} from '@/hooks/queries/use-agent-parity-queries';
import { AgentChatInput } from '@/components/weldagent/agent-chat-input';
import {
  AssistantMessage,
  TypingIndicator,
  ToolSteps,
  UserMessage,
  humanizeToolName,
} from '@/components/weldagent/chat/chat-message';
import { QuestionCard } from '@/components/weldagent/chat/question-card';
import { ApprovalBar } from './approval-bar';
import { approvalStateOf, type ApprovalState } from './approval-state';
import { ChatSkeleton } from './chat-skeleton';
import { DelegationSteps } from './delegation-steps';
import { RoutineNotice } from './routine-notice';
import { browserTimezone } from '../routine-schedule';
import { SetupWelcome } from './setup-welcome';
import { agentChangesIn, buildThread, mergeMessages, openQuestion, type ThreadItem } from './thread';
import { errorMessage } from './labels';

/** Background turns run in a durable workflow (10 min step budget). */
const REPLY_TIMEOUT_MS = 10 * 60_000;
/** After this long, reassure the user the agent is still on it. */
const STILL_WORKING_AFTER_MS = 30_000;
/** Messages per page: the latest page loads first, older ones on request. */
const PAGE_SIZE = 100;
/** While a reply is on its way the agent may park an action: look for it often. */
const APPROVALS_POLL_WHILE_WAITING_MS = 3_000;
/** A freshly opened chat holds the newest message in view for this long while it settles. */
const OPEN_PIN_MS = 1_500;

interface AgentChatProps {
  agentId: string;
  agentName: string;
  needsSetup: boolean;
  /** The person's one continuous chat with the agent; null while it opens. */
  conversationId: string | null;
  /** Open the settings sheet on its Routines tab. */
  onOpenRoutines: () => void;
}

/** One line under a reply for each action the agent parked for approval. */
function ApprovalNote({ state, toolName }: Readonly<{ state: ApprovalState; toolName: string }>) {
  const t = getTranslations('common').agents.detail.approvals;
  const look = {
    waiting: { Icon: Clock, text: t.waiting, tone: '' },
    approved: { Icon: CheckCircle2, text: t.approvedAction, tone: 'text-emerald-600' },
    rejected: { Icon: XCircle, text: t.rejectedAction, tone: 'text-destructive' },
    handled: { Icon: Clock, text: t.handled, tone: '' },
  }[state];
  return (
    <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <look.Icon className={cn('h-3.5 w-3.5 shrink-0', look.tone)} />
      {look.text.replace('{action}', humanizeToolName(toolName).toLowerCase())}
    </p>
  );
}

function AssistantTurn({
  item,
  approvalState,
  questionActive,
  onAnswer,
  onOpenRoutines,
  pendingAnswer,
}: Readonly<{
  item: Extract<ThreadItem, { kind: 'assistant' }>;
  /** The answer being sent for this turn's open question. */
  pendingAnswer: string | null;
  approvalState: (approvalId: string, askedAt: string) => ApprovalState;
  questionActive: boolean;
  onAnswer: (text: string) => void;
  onOpenRoutines: () => void;
}>) {
  const t = getTranslations('common').agents.detail;
  return (
    <div className="space-y-2.5 animate-in fade-in duration-200">
      {item.routineName !== null && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <CalendarClock className="h-3.5 w-3.5" />
          {item.routineName ? t.routineNotice.postedBy.replace('{name}', item.routineName) : t.routineNotice.postedByRoutine}
        </p>
      )}
      <DelegationSteps delegations={item.delegations} />
      <AssistantMessage content={item.content} />
      {item.approvals.map((approval) => (
        <ApprovalNote
          key={approval.approvalId}
          state={approvalState(approval.approvalId, item.createdAt)}
          toolName={approval.toolName}
        />
      ))}
      {item.routines.map((routine) => (
        <RoutineNotice key={routine.routineId} routine={routine} onManage={onOpenRoutines} />
      ))}
      <ToolSteps steps={item.steps} />
      {item.questions.map(({ question, answer }) => (
        <QuestionCard
          key={question.question}
          question={question}
          answer={answer ?? pendingAnswer}
          active={questionActive && answer === null}
          onAnswer={onAnswer}
        />
      ))}
    </div>
  );
}

export function AgentChat({
  agentId,
  agentName,
  needsSetup,
  conversationId,
  onOpenRoutines,
}: Readonly<AgentChatProps>) {
  const t = getTranslations('common').agents.detail;
  const qc = useQueryClient();
  const completeTurn = useCompleteConversationTurn();
  const loadOlderPage = useLoadOlderMessages();

  const [input, setInput] = useState('');
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [awaitingAfterId, setAwaitingAfterId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stillWorking, setStillWorking] = useState(false);
  /**
   * Once older pages are loaded: every message seen so far, oldest first. The
   * live query is a sliding window of the newest page, so messages leaving it
   * are kept here instead of vanishing from the middle of the chat.
   */
  const [older, setOlder] = useState<WeldAgentMessage[]>([]);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  /** A send is under way: a second click or Enter before the screen updates must not send twice. */
  const sendingRef = useRef(false);
  /** The newest reply already acted on; undefined until the history first loads. */
  const handledReplyRef = useRef<string | null | undefined>(undefined);

  const { data: pendingApprovals = [] } = useAgentApprovals(agentId, {
    refetchInterval: awaitingAfterId ? APPROVALS_POLL_WHILE_WAITING_MS : undefined,
  });

  // Another agent's chat: drop this one's in-flight state and history pages.
  useEffect(() => {
    setInput('');
    setPendingUser(null);
    setAwaitingAfterId(null);
    setError(null);
    setOlder([]);
    setOlderExhausted(false);
    handledReplyRef.current = undefined;
  }, [conversationId]);

  const { data: latest = [], isLoading } = useWeldAgentConversationMessages(conversationId, PAGE_SIZE, {
    refetchInterval: awaitingAfterId ? 1500 : false,
  });
  // After paging back, fold each new window into what was kept.
  useEffect(() => {
    if (latest.length === 0) return;
    setOlder((current) => (current.length === 0 ? current : mergeMessages(current, latest)));
  }, [latest]);
  const messages = useMemo(() => mergeMessages(older, latest), [older, latest]);
  const hasOlder = !olderExhausted && (older.length > 0 || latest.length >= PAGE_SIZE);

  const loadOlder = useCallback(async () => {
    const first = messages[0];
    if (!conversationId || !first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await loadOlderPage(conversationId, first.id, PAGE_SIZE);
      if (page.length < PAGE_SIZE) setOlderExhausted(true);
      setOlder((current) => mergeMessages(page, current, latest));
    } catch (err) {
      setError(errorMessage(err, t.chat.loadOlderFailed));
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, latest, loadOlderPage, loadingOlder, messages, t.chat.loadOlderFailed]);

  const thread = useMemo(() => buildThread(messages), [messages]);
  const question = openQuestion(thread);
  const lastId = thread[thread.length - 1]?.id;
  const pendingApprovalIds = useMemo(() => new Set(pendingApprovals.map((a) => a.id)), [pendingApprovals]);

  // Approvals the thread mentions that are no longer pending: how did they end?
  const showsSettledApproval = thread.some(
    (item) => item.kind === 'assistant' && item.approvals.some((a) => !pendingApprovalIds.has(a.approvalId)),
  );
  const { data: decidedApprovals } = useDecidedApprovals(agentId, showsSettledApproval);
  const approvalState = useCallback(
    (approvalId: string, askedAt: string) =>
      approvalStateOf(approvalId, pendingApprovalIds, decidedApprovals, askedAt),
    [pendingApprovalIds, decidedApprovals],
  );

  // A reply landed (from this turn, a routine, or another tab): the agent may
  // have parked an action for approval or edited itself (setup, routines,
  // skills, memory), so refresh what the screen shows about it.
  const newestReply = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant'), [messages]);
  useEffect(() => {
    if (!conversationId || isLoading) return;
    const id = newestReply?.id ?? null;
    if (handledReplyRef.current === undefined) {
      // The history that was already there when the chat opened is not news.
      handledReplyRef.current = id;
      return;
    }
    if (handledReplyRef.current === id || !newestReply) return;
    handledReplyRef.current = id;
    void qc.invalidateQueries({ queryKey: agentParityKeys.approvals(agentId) });
    const changes = agentChangesIn(newestReply);
    if (needsSetup || changes.agent) void qc.invalidateQueries({ queryKey: agentKeys.all });
    if (changes.routines) void qc.invalidateQueries({ queryKey: agentParityKeys.routines(agentId) });
    if (changes.skills) void qc.invalidateQueries({ queryKey: agentParityKeys.skills(agentId) });
    if (changes.memories) void qc.invalidateQueries({ queryKey: agentParityKeys.memories(agentId) });
  }, [agentId, conversationId, isLoading, needsSetup, newestReply, qc]);

  // The cloud reply landed: drop the optimistic bubble and stop polling.
  useEffect(() => {
    if (!awaitingAfterId) return;
    const userIdx = messages.findIndex((m) => m.id === awaitingAfterId);
    if (userIdx < 0) return;
    setPendingUser(null);
    // Approval outcomes and routine results can land meanwhile; they are not this turn's reply.
    const reply = messages
      .slice(userIdx + 1)
      .find(
        (m) =>
          m.role === 'assistant' && m.metadata?.kind !== 'approval_outcome' && m.metadata?.kind !== 'routine_result',
      );
    if (!reply) return;
    setAwaitingAfterId(null);
  }, [messages, awaitingAfterId]);

  // Never leave the typing indicator stuck if the reply never lands.
  useEffect(() => {
    setStillWorking(false);
    if (!awaitingAfterId) return;
    const reassure = window.setTimeout(() => setStillWorking(true), STILL_WORKING_AFTER_MS);
    const giveUp = window.setTimeout(() => {
      setAwaitingAfterId(null);
      setPendingUser(null);
      setError(t.chat.replyTimedOut);
      if (conversationId) {
        void qc.invalidateQueries({ queryKey: weldagentKeys.conversationMessages(conversationId) });
      }
    }, REPLY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(reassure);
      window.clearTimeout(giveUp);
    };
  }, [awaitingAfterId, conversationId, qc, t.chat.replyTimedOut]);

  const isWaiting = Boolean(awaitingAfterId) || completeTurn.isPending;
  const busy = isWaiting || !conversationId;
  const loadingChat = !conversationId || (isLoading && messages.length === 0);

  // Open at the newest message, and hold it there while the thread settles
  // (markdown and late history change its height) unless the reader scrolls.
  const hasThread = thread.length > 0;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!hasThread || !scroller || !content) return;
    let pinned = true;
    const toBottom = () => {
      if (pinned) scroller.scrollTop = scroller.scrollHeight;
    };
    const release = () => {
      pinned = false;
    };
    toBottom();
    const observer = new ResizeObserver(toBottom);
    observer.observe(content);
    scroller.addEventListener('wheel', release, { passive: true });
    scroller.addEventListener('touchstart', release, { passive: true });
    scroller.addEventListener('pointerdown', release);
    const timer = window.setTimeout(release, OPEN_PIN_MS);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      scroller.removeEventListener('wheel', release);
      scroller.removeEventListener('touchstart', release);
      scroller.removeEventListener('pointerdown', release);
    };
  }, [hasThread]);

  // Follow the newest message (not older pages loaded above it).
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lastId, pendingUser, isWaiting]);

  const send = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      const id = conversationId;
      if (!content || busy || !id || sendingRef.current) return;
      sendingRef.current = true;
      setError(null);
      setInput('');
      setPendingUser(content);

      try {
        // The setup interview waits for its reply so a configuration error
        // shows at once; live agents reply in the background.
        const result = await completeTurn.mutateAsync({
          conversationId: id,
          content,
          agentId,
          wait: needsSetup,
          timezone: browserTimezone(),
        });
        if (result?.pending && result.userMessage?.id) {
          setAwaitingAfterId(result.userMessage.id);
          return;
        }
        setPendingUser(null);
        await qc.invalidateQueries({ queryKey: weldagentKeys.conversationMessages(id) });
      } catch (err) {
        setPendingUser(null);
        setAwaitingAfterId(null);
        setError(errorMessage(err, t.chat.sendFailed));
      } finally {
        sendingRef.current = false;
      }
    },
    [agentId, busy, completeTurn, conversationId, needsSetup, qc, t.chat.sendFailed],
  );

  const empty = thread.length === 0 && !pendingUser && Boolean(conversationId) && !isLoading;

  let placeholder = t.chat.inputPlaceholder.replace('{name}', agentName);
  if (question) placeholder = t.questions.composerPlaceholder;
  else if (needsSetup) placeholder = t.setup.composerPlaceholder;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 sm:px-6">
          {loadingChat && <ChatSkeleton />}
          {empty && needsSetup && <SetupWelcome disabled={busy} onPick={(text) => void send(text)} />}
          {empty && !needsSetup && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-16 text-center">
              <p className="text-lg font-medium">{t.chat.emptyTitle}</p>
              <p className="text-sm text-muted-foreground">{t.chat.emptyHint.replace('{name}', agentName)}</p>
            </div>
          )}
          {!empty && !loadingChat && (
            <div ref={contentRef} className="space-y-6 py-6">
              {hasOlder && (
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground"
                    disabled={loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    {loadingOlder ? t.chat.loadingOlder : t.chat.loadOlder}
                  </Button>
                </div>
              )}
              {thread.map((item) => {
                if (item.kind === 'assistant') {
                  return (
                    <AssistantTurn
                      key={item.id}
                      item={item}
                      approvalState={approvalState}
                      questionActive={!busy}
                      onAnswer={(text) => void send(text)}
                      onOpenRoutines={onOpenRoutines}
                      pendingAnswer={item.id === lastId && question ? pendingUser : null}
                    />
                  );
                }
                // An answer to a question card is shown on the card itself.
                if (item.answersQuestion) return null;
                return <UserMessage key={item.id}>{item.content}</UserMessage>;
              })}
              {pendingUser && !question && (
                <div className="animate-in fade-in duration-150">
                  <UserMessage>{pendingUser}</UserMessage>
                </div>
              )}
              {isWaiting && <TypingIndicator label={stillWorking ? t.chat.stillWorking : null} />}
              <div ref={scrollEndRef} />
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          {error && <p className="mb-2 px-1 text-sm text-destructive animate-in fade-in">{error}</p>}
          <ApprovalBar agentId={agentId} />
          <AgentChatInput
            value={input}
            onChange={setInput}
            onSubmit={(text) => void send(text)}
            placeholder={placeholder}
            isSending={isWaiting}
            disabled={!conversationId}
            autoFocus
          />
          {question && <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{t.questions.keyboardHint}</p>}
        </div>
      </div>
    </div>
  );
}
