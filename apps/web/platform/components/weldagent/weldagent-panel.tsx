import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Send, Sparkles, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { FloatingDrawer } from '@/components/layout/floating-drawer';
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

  const submit = useCallback(() => {
    if (!input.trim() || isSending) return;
    sendMessage(input);
    setInput('');
  }, [input, isSending, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const isEmpty = messages.length === 0;
  const suggestions = entityContext?.suggestedPrompts?.slice(0, 4) ?? [];
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  return (
    <FloatingDrawer
      isOpen={isOpen}
      width={width}
      skipAnimation={disableAnimation}
      className={className}
      data-testid="weldagent-panel"
    >
      <div className="flex items-center justify-between px-4 h-14 border-b border-gray-200 dark:border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="h-4 w-4 text-primary flex-shrink-0" />
          <span className="text-sm font-semibold text-gray-900 dark:text-foreground truncate">
            {selectedAgent?.name ?? 'WeldAgent'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!isEmpty && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                reset();
                setInput('');
              }}
            >
              {t.newChat}
            </Button>
          )}
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
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Sparkles className="h-6 w-6 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{t.emptyTitle}</p>
              <p className="text-sm text-muted-foreground max-w-xs">{t.emptyBody}</p>
            </div>
            {suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => sendMessage(s)}
                    className="rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground hover:bg-muted"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
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

      <div className="border-t border-gray-200 dark:border-border p-3 flex-shrink-0">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t.placeholder}
            rows={1}
            className="max-h-40 min-h-[40px] resize-none"
            disabled={isSending}
          />
          <Button
            size="sm"
            className="h-10 w-10 flex-shrink-0 p-0"
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
    </FloatingDrawer>
  );
}
