import { useEffect, useRef } from 'react';
import { ArrowUp, CornerDownRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { useRecordTags } from './record-tags';

/**
 * The empty-state chips of the general assistant. Each one needs data the
 * assistant can read with the user's own permissions (tasks, projects, people,
 * tickets), so a chip never leads to "I can't see that".
 */
export function getDefaultAgentSuggestions(): string[] {
  const s = getTranslations('common').ai.chat.suggestions;
  return [s.today, s.tasks, s.crm];
}

interface AgentChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  isSending?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

/**
 * The WeldAgent composer: grows with its text, Enter sends, Shift+Enter breaks
 * a line, `@` tags a spreadsheet or another record (`./record-tags`).
 */
export function AgentChatInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  isSending = false,
  disabled = false,
  autoFocus = false,
  className,
}: Readonly<AgentChatInputProps>) {
  const t = getTranslations('common').ai.chat;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const tags = useRecordTags(value, onChange, textareaRef);
  const canSubmit = value.trim().length > 0 && !isSending && !disabled;
  const submit = () => {
    if (canSubmit) onSubmit(tags.toSend(value));
  };

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
        submit();
      }}
      className={cn('w-full', className)}
    >
      <div
        role="presentation"
        className={cn(
          'relative flex cursor-text items-end gap-2 rounded-2xl border bg-background py-2 pl-4 pr-2',
          'shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors focus-within:border-foreground/25',
          disabled && 'opacity-60',
        )}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) textareaRef.current?.focus();
        }}
      >
        {tags.menu}
        <textarea
          ref={textareaRef}
          value={value}
          disabled={disabled}
          aria-autocomplete="list"
          aria-expanded={tags.open}
          onChange={(e) => {
            onChange(e.target.value);
            tags.sync(e.target);
          }}
          onSelect={(e) => tags.sync(e.currentTarget)}
          onKeyDown={(e) => {
            if (tags.onKeyDown(e)) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder ?? t.placeholder}
          rows={1}
          className="max-h-[200px] min-h-[36px] flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <button
          type="submit"
          disabled={!canSubmit}
          aria-label={t.send}
          title={t.send}
          className={cn(
            'mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors',
            canSubmit ? 'bg-foreground text-background hover:bg-foreground/90' : 'bg-muted text-muted-foreground',
          )}
        >
          {isSending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          )}
        </button>
      </div>
    </form>
  );
}

interface AgentSuggestionsProps {
  suggestions?: string[];
  onSelect: (suggestion: string) => void;
}

export function AgentSuggestions({ suggestions, onSelect }: Readonly<AgentSuggestionsProps>) {
  const items = suggestions ?? getDefaultAgentSuggestions();
  return (
    <div className="space-y-0.5">
      {items.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onSelect(suggestion)}
          className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <CornerDownRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
          {suggestion}
        </button>
      ))}
    </div>
  );
}
