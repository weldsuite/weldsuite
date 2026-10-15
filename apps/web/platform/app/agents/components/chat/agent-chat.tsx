'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Clock } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { getTranslations } from '@/lib/i18n';
import {
  useCompleteConversationTurn,
  useCreateConversation,
  useWeldAgentConversationMessages,
  weldagentKeys,
} from '@/hooks/queries/use-weldagent-queries';
import { useAgentApprovals } from '@/hooks/queries/use-agent-parity-queries';
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
import { RoutineNotice } from './routine-notice';
import { browserTimezone } from '../routine-schedule';
import { SetupWelcome } from './setup-welcome';
import { buildThread, openQuestion, type ThreadItem } from './thread';
import { errorMessage } from './labels';

/** Background turns run in a durable workflow (10 min step budget). */
const REPLY_TIMEOUT_MS = 10 * 60_000;
/** After this long, reassure the user the agent is still on it. */
const STILL_WORKING_AFTER_MS = 30_000;

interface AgentChatProps {
  agentId: string;
  agentName: string;
  needsSetup: boolean;
  /** The open conversation; null starts a new one on the first message. */
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  /** Open the settings sheet on its Routines tab. */
  onOpenRoutines: () => void;
}

function AssistantTurn({
  item,
  pendingApprovalIds,
  questionActive,
  onAnswer,
  onOpenRoutines,
  pendingAnswer,
}: Readonly<{
  item: Extract<ThreadItem, { kind: 'assistant' }>;
  /** The answer being sent for this turn's open question. */
  pendingAnswer: string | null;
  pendingApprovalIds: Set<string>;
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
      <AssistantMessage content={item.content} />
      {item.approvals.map((approval) => (
        <p key={approval.approvalId} className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          {(pendingApprovalIds.has(approval.approvalId) ? t.approvals.waiting : t.approvals.handled).replace(
            '{action}',
            humanizeToolName(approval.toolName).toLowerCase(),
          )}
        </p>
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
  onConversationCreated,
  onOpenRoutines,
}: Readonly<AgentChatProps>) {
  const t = getTranslations('common').agents.detail;
  const qc = useQueryClient();
  const createConversation = useCreateConversation();
  const completeTurn = useCompleteConversationTurn();
  const { data: pendingApprovals = [] } = useAgentApprovals(agentId);

  const [input, setInput] = useState('');
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [awaitingAfterId, setAwaitingAfterId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stillWorking, setStillWorking] = useState(false);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  /** The conversation this panel created on a first send: switching to it keeps the in-flight turn. */
  const createdIdRef = useRef<string | null>(null);

  // Opening another conversation drops this one's in-flight state.
  useEffect(() => {
    if (conversationId && conversationId === createdIdRef.current) return;
    createdIdRef.current = null;
    setInput('');
    setPendingUser(null);
    setAwaitingAfterId(null);
    setError(null);
  }, [conversationId]);

  const { data: messages = [], isLoading } = useWeldAgentConversationMessages(conversationId, 100, {
    refetchInterval: awaitingAfterId ? 1500 : false,
  });
  const thread = useMemo(() => buildThread(messages), [messages]);
  const question = openQuestion(thread);
  const lastId = thread[thread.length - 1]?.id;
  const pendingApprovalIds = useMemo(() => new Set(pendingApprovals.map((a) => a.id)), [pendingApprovals]);

  const refreshAgent = useCallback(() => {
    if (needsSetup) void qc.invalidateQueries({ queryKey: ['workspace-agents'] });
  }, [needsSetup, qc]);

  // The cloud reply landed: drop the optimistic bubble and stop polling.
  useEffect(() => {
    if (!awaitingAfterId) return;
    const userIdx = messages.findIndex((m) => m.id === awaitingAfterId);
    if (userIdx < 0) return;
    setPendingUser(null);
    // Approval outcome notes can land meanwhile; they are not this turn's reply.
    const reply = messages
      .slice(userIdx + 1)
      .find((m) => m.role === 'assistant' && m.metadata?.kind !== 'approval_outcome');
    if (!reply) return;
    setAwaitingAfterId(null);
    refreshAgent();
  }, [messages, awaitingAfterId, refreshAgent]);

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
  const busy = isWaiting || createConversation.isPending;

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [thread.length, pendingUser, isWaiting]);

  const send = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      if (!content || busy) return;
      setError(null);
      setInput('');
      setPendingUser(content);

      try {
        let id = conversationId;
        if (!id) {
          const conv = await createConversation.mutateAsync({
            name: needsSetup ? t.setup.chatName : t.chat.newChatName,
            agentId,
          });
          id = conv.id;
          createdIdRef.current = id;
          onConversationCreated(id);
        }
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
        refreshAgent();
      } catch (err) {
        setPendingUser(null);
        setAwaitingAfterId(null);
        setError(errorMessage(err, t.chat.sendFailed));
      }
    },
    [
      agentId,
      busy,
      completeTurn,
      conversationId,
      createConversation,
      needsSetup,
      onConversationCreated,
      qc,
      refreshAgent,
      t.chat.newChatName,
      t.chat.sendFailed,
      t.setup.chatName,
    ],
  );

  const empty = thread.length === 0 && !pendingUser && !(conversationId && isLoading);

  let placeholder = t.chat.inputPlaceholder.replace('{name}', agentName);
  if (question) placeholder = t.questions.composerPlaceholder;
  else if (needsSetup) placeholder = t.setup.composerPlaceholder;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 sm:px-6">
          {empty && needsSetup && <SetupWelcome disabled={busy} onPick={(text) => void send(text)} />}
          {empty && !needsSetup && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-16 text-center">
              <p className="text-lg font-medium">{t.chat.emptyTitle}</p>
              <p className="text-sm text-muted-foreground">{t.chat.emptyHint.replace('{name}', agentName)}</p>
            </div>
          )}
          {!empty && (
            <div className="space-y-6 py-6">
              {thread.map((item) => {
                if (item.kind === 'assistant') {
                  return (
                    <AssistantTurn
                      key={item.id}
                      item={item}
                      pendingApprovalIds={pendingApprovalIds}
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
            disabled={createConversation.isPending}
            autoFocus
          />
          {question && <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{t.questions.keyboardHint}</p>}
        </div>
      </div>
    </div>
  );
}
