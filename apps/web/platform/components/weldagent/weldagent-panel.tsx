import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { Check, ChevronDown, Sheet, SquarePen, X } from 'lucide-react';
import type { AiChatContext } from '@weldsuite/app-api-client/schemas/ai';
import { splitQuestionMarkers } from '@weldsuite/app-api-client/schemas/weldagent-questions';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { FloatingDrawer } from '@/components/layout/floating-drawer';
import { AgentChatInput, AgentSuggestions, getDefaultAgentSuggestions } from './agent-chat-input';
import { AssistantMessage, TypingIndicator, UserMessage } from './chat/chat-message';
import { QuestionCard } from './chat/question-card';
import { messagesToRemember, panelSessionAtom } from './panel-session';
import { getTranslations } from '@/lib/i18n';
import { usePathname } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useWeldAgentChat, type ChatMessage } from '@/hooks/queries/use-ai-chat';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import { useBetaAppCodes } from '@/hooks/queries/use-settings-queries';
import { BetaBadge } from '@/components/layout/beta-badge';
import type { EntityContext } from '@/lib/weldagent/tools/types';

interface WeldAgentPanelProps {
  isOpen: boolean;
  onClose: () => void;
  entityContext?: EntityContext;
  width?: number;
  disableAnimation?: boolean;
  className?: string;
  forceNewConversation?: boolean;
  onNewConversationCreated?: () => void;
  prefillText?: string | null;
  onPrefillConsumed?: () => void;
}

/** A string field of the page context, cut to what the chat request accepts. */
function contextText(data: Record<string, unknown> | undefined, key: string, max: number): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

/** The spreadsheet open on the page (WeldSheets publishes it), for the agent to work on. */
function chatContextOf(entity: EntityContext | undefined): AiChatContext | undefined {
  if (entity?.type !== 'sheet' || !entity.id) return undefined;
  return {
    sheet: {
      id: entity.id,
      name: entity.title?.slice(0, 255),
      tab: contextText(entity.data, 'tab', 200),
      selection: contextText(entity.data, 'selection', 200),
    },
  };
}

/** One rendered turn: streamed questions are lifted out of the reply text. */
function PanelMessage({
  message,
  answer,
  isLast,
  isSending,
  onAnswer,
}: Readonly<{
  message: ChatMessage;
  answer: string | null;
  isLast: boolean;
  isSending: boolean;
  onAnswer: (text: string) => void;
}>) {
  const { text, questions } = useMemo(() => splitQuestionMarkers(message.content), [message.content]);
  if (message.role === 'user') return <UserMessage>{message.content}</UserMessage>;
  if (!text && questions.length === 0) return isSending && isLast ? <TypingIndicator /> : null;
  return (
    <div className="space-y-2.5">
      <AssistantMessage content={text} className="text-sm" />
      {questions.map((question) => (
        <QuestionCard
          key={question.question}
          question={question}
          answer={answer}
          active={isLast && !isSending && answer === null}
          onAnswer={onAnswer}
        />
      ))}
    </div>
  );
}

export function WeldAgentPanel({
  isOpen,
  onClose,
  entityContext,
  width = 400,
  disableAnimation = false,
  className,
  forceNewConversation = false,
  onNewConversationCreated,
  prefillText,
  onPrefillConsumed,
}: Readonly<WeldAgentPanelProps>) {
  const t = getTranslations('common').ai.chat;
  const pathname = usePathname();
  const { data: agents = [], isSuccess: agentsLoaded } = useAgents();
  const { data: betaAppCodes } = useBetaAppCodes();
  // The agent and the conversation outlive the panel: it unmounts on close.
  const [session, setSession] = useAtom(panelSessionAtom);
  const selectedAgent = agents.find((a) => a.id === session.agentId) ?? null;
  // An agent that was deleted (or is no longer visible) falls back to WeldAgent.
  const selectedAgentId = selectedAgent || !agentsLoaded ? session.agentId : '';
  const [restored] = useState(() => session.messages);

  const chatContext = useMemo(() => chatContextOf(entityContext), [entityContext]);
  const openSheet = chatContext?.sheet;
  const { messages, sendMessage, retry, reset, stop, isSending, error } = useWeldAgentChat({
    system: entityContext?.customSystemPrompt,
    agentId: selectedAgentId || null,
    context: chatContext,
    initialMessages: restored,
  });

  // Remember the conversation, so a reopened panel picks it up: once a reply
  // has finished, and again when the panel closes (which ends a reply that is
  // still streaming in, keeping what arrived).
  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  useEffect(() => {
    if (isSending) return;
    const remembered = messagesToRemember(messages);
    setSession((prev) => (prev.messages === remembered ? prev : { ...prev, messages: remembered }));
  }, [messages, isSending, setSession]);
  useEffect(
    () => () => {
      stop();
      const remembered = messagesToRemember(latestMessages.current);
      setSession((prev) => ({ ...prev, messages: remembered }));
    },
    [stop, setSession],
  );

  const [input, setInput] = useState('');
  const scrollEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && forceNewConversation) {
      reset();
      setInput('');
      onNewConversationCreated?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, forceNewConversation]);

  useEffect(() => {
    if (prefillText) {
      setInput(prefillText);
      onPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillText]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isSending]);

  const submit = useCallback(
    (text: string) => {
      if (!text.trim() || isSending) return;
      sendMessage(text);
      setInput('');
    },
    [isSending, sendMessage],
  );

  const switchAgent = (id: string) => {
    setSession({ agentId: id, messages: [] });
    reset();
    setInput('');
  };

  const isEmpty = messages.length === 0;
  const contextSuggestions = entityContext?.suggestedPrompts?.slice(0, 3) ?? [];
  const suggestions = contextSuggestions.length > 0 ? contextSuggestions : getDefaultAgentSuggestions();
  // The generic chips are for the general assistant, and the Home page already
  // shows the same ones right next to the panel.
  const onHome = pathname === '/' || pathname === '';
  const showSuggestions = isEmpty && !input.trim() && !selectedAgent && !onHome;
  const emptyBody = selectedAgent
    ? selectedAgent.description?.trim() || t.agentEmptyBody.replace('{name}', selectedAgent.name)
    : t.emptyBody;
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  return (
    <FloatingDrawer
      isOpen={isOpen}
      width={width}
      skipAnimation={disableAnimation}
      className={className}
      data-testid="weldagent-panel"
    >
      <div className="flex h-[53px] flex-shrink-0 items-center justify-between gap-2 border-b px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {agents.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-semibold hover:bg-accent"
                  aria-label={t.chooseAgent}
                >
                  <span className="truncate">{selectedAgent?.name ?? t.generalAgent}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuItem onSelect={() => switchAgent('')} className="flex items-center justify-between">
                  <span>{t.generalAgent}</span>
                  {!selectedAgent && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {agents.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onSelect={() => switchAgent(a.id)}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0 truncate">{a.name}</span>
                    {a.id === selectedAgent?.id ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      a.status !== 'active' && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {getTranslations('common').agents.status[a.status]}
                        </span>
                      )
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="truncate px-1.5 text-sm font-semibold">{t.generalAgent}</span>
          )}
          {betaAppCodes?.has('weldagent') ? <BetaBadge variant="inline" /> : null}
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => {
              reset();
              setInput('');
            }}
            title={t.newChat}
            aria-label={t.newChat}
          >
            <SquarePen className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} aria-label={t.close}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {isEmpty ? (
          <div className="flex h-full flex-col justify-end pb-2">
            <p className="text-base font-medium">{t.emptyTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">{emptyBody}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {messages.map((m, index) => (
              <PanelMessage
                key={m.id}
                message={m}
                answer={messages.slice(index + 1).find((later) => later.role === 'user')?.content ?? null}
                isLast={m.id === lastAssistantId && index === messages.length - 1}
                isSending={isSending}
                onAnswer={submit}
              />
            ))}
            <div ref={scrollEndRef} />
          </div>
        )}
      </div>

      {error && (
        <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{error === 'credits' ? t.insufficientCredits : t.error}</span>
          {error === 'generic' && (
            <button type="button" onClick={retry} className="font-medium underline underline-offset-2 hover:opacity-80">
              {t.retry}
            </button>
          )}
        </div>
      )}

      {showSuggestions && (
        <div className="flex-shrink-0 px-3 pb-2">
          <AgentSuggestions suggestions={suggestions} onSelect={submit} />
        </div>
      )}

      <div className={cn('flex-shrink-0 px-3 pb-3', !isEmpty && 'pt-1')}>
        {openSheet && (
          <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 text-xs text-muted-foreground" data-testid="weldagent-open-sheet">
            <Sheet className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t.openSheet.replace('{name}', openSheet.name ?? '')}</span>
            {openSheet.selection && <span className="shrink-0">· {openSheet.selection}</span>}
          </div>
        )}
        <AgentChatInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          placeholder={selectedAgent ? t.messageAgent.replace('{name}', selectedAgent.name) : t.placeholder}
          isSending={isSending}
        />
      </div>
    </FloatingDrawer>
  );
}
