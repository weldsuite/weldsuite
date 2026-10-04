import { useEffect, useRef } from 'react';
import { CornerDownRight, Loader2, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';

export const DEFAULT_AGENT_SUGGESTIONS = ["What's new today?", 'Show my notifications', 'Summarize my inbox'];

interface AgentChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  isSending?: boolean;
  autoFocus?: boolean;
}

export function AgentChatInput({
  value,
  onChange,
  onSubmit,
  placeholder = 'Ask anything…',
  isSending = false,
  autoFocus = false,
}: AgentChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSubmit = value.trim().length > 0 && !isSending;

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit(value);
      }}
      className="w-full"
    >
      <div
        role="presentation"
        className="relative bg-white dark:bg-background border border-gray-200 dark:border-border rounded-[20px] px-[10px] pt-[10px] pb-[10px] w-full flex flex-col shadow-[0_1px_4px_-1px_rgba(0,0,0,0.03)] cursor-text"
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (!target.closest('button') && textareaRef.current) {
            textareaRef.current.focus();
          }
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSubmit) onSubmit(value);
            }
          }}
          placeholder={placeholder}
          rows={1}
          className="w-full bg-transparent text-[15px] text-gray-900 dark:text-foreground placeholder:text-gray-500 dark:placeholder:text-muted-foreground outline-none resize-none min-h-[40px] flex-1 pl-[10px] pt-[7px] pb-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words"
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(200,200,200,0.3) transparent' }}
        />

        <div className="flex items-center justify-between mt-auto">
          <div className="flex items-center gap-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
              title="Add"
            >
              <Plus className="h-[18px] w-[18px]" />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              disabled={!canSubmit}
              className={cn(
                'w-8 h-8 rounded-[12px] flex items-center justify-center transition-all',
                canSubmit
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-gray-300 dark:bg-muted text-gray-500 dark:text-muted-foreground cursor-not-allowed'
              )}
              title="Send message"
            >
              {isSending ? (
                <Loader2 className="h-[15px] w-[15px] animate-spin" />
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="2.5"
                  stroke="currentColor"
                  className={cn(
                    'h-[15px] w-[15px]',
                    canSubmit ? 'text-primary-foreground' : 'text-gray-500 dark:text-muted-foreground'
                  )}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
                </svg>
              )}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

interface AgentSuggestionsProps {
  suggestions?: string[];
  onSelect: (suggestion: string) => void;
}

export function AgentSuggestions({ suggestions = DEFAULT_AGENT_SUGGESTIONS, onSelect }: AgentSuggestionsProps) {
  return (
    <div className="space-y-1">
      {suggestions.map((suggestion) => (
        <Button
          key={suggestion}
          type="button"
          variant="ghost"
          onClick={() => onSelect(suggestion)}
          className="group flex items-center justify-start gap-3 w-full text-left px-2 py-2 text-sm text-gray-700 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-accent hover:text-gray-900 dark:hover:text-foreground rounded-lg transition-colors"
        >
          <CornerDownRight className="h-4 w-4 text-gray-400 group-hover:text-gray-700 dark:group-hover:text-foreground flex-shrink-0 transition-colors" />
          {suggestion}
        </Button>
      ))}
    </div>
  );
}
