import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, SquarePen, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { FloatingDrawer } from '@/components/layout/floating-drawer';
import { AgentChatInput, AgentSuggestions, DEFAULT_AGENT_SUGGESTIONS } from './agent-chat-input';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useWeldAgentChat } from '@/hooks/queries/use-ai-chat';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import type { ModuleKey, EntityContext } from '@/lib/weldagent/tools/types';

interface WeldAgentPanelProps {
  isOpen: boolean;
  onClose: () => void;
  moduleKey?: ModuleKey;
  entityContext?: EntityContext;
  width?: number;
  disableAnimation?: boolean;
  className?: string;
  saveHistory?: boolean;
  onToolResult?: (toolName: string, result: unknown) => void;
  autoRefreshOnMutation?: boolean;
  forceNewConversation?: boolean;
  onNewConversationCreated?: () => void;
  prefillText?: string | null;
  onPrefillConsumed?: () => void;
  onWidthChange?: (width: number) => void;
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
}: WeldAgentPanelProps) {
  const t = getTranslations('common').ai.chat;
  const { data: agents = [] } = useAgents();
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');

  const { messages, sendMessage, retry, reset, isSending, error } = useWeldAgentChat({
    system: entityContext?.customSystemPrompt,
    agentId: selectedAgentId || null,
  });

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

  const isEmpty = messages.length === 0;
  const contextSuggestions = entityContext?.suggestedPrompts?.slice(0, 3) ?? [];
  const suggestions = contextSuggestions.length > 0 ? contextSuggestions : DEFAULT_AGENT_SUGGESTIONS;
  // The panel chat isn't saved, so title it the way saved chats are: from the first user message.
  const firstUserMessage = messages.find((m) => m.role === 'user')?.content ?? '';
  const chatTitle = firstUserMessage.replace(/\s+/g, ' ').trim().slice(0, 60) || t.newChat;

  return (
    <FloatingDrawer
      isOpen={isOpen}
      width={width}
      skipAnimation={disableAnimation}
      className={className}
      data-testid="weldagent-panel"
    >
      <div className="flex items-center justify-between px-4 h-[53px] border-b border-gray-200 dark:border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-gray-900 dark:text-foreground truncate">
            {chatTitle}
          </span>
        </div>
        <div className="flex items-center gap-1">
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
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {agents.length > 0 && (
        <div className="px-4 py-2 border-b border-border flex-shrink-0">
          <select
            className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
            value={selectedAgentId}
            onChange={(e) => {
              setSelectedAgentId(e.target.value);
              reset();
              setInput('');
            }}
            aria-label="Select agent"
          >
            <option value="">WeldAgent (general)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.status !== 'active' ? ` (${a.status})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!isEmpty && (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm',
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

      {error && (
        <div className="mx-4 mb-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
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

      {isEmpty && !input.trim() && (
        <div className="px-3 pb-3 flex-shrink-0">
          <AgentSuggestions suggestions={suggestions} onSelect={submit} />
        </div>
      )}

      <div className="px-3 pb-3 flex-shrink-0">
        <AgentChatInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          placeholder={t.placeholder}
          isSending={isSending}
        />
      </div>
    </FloatingDrawer>
  );
}
