import { useEffect, useRef, type MouseEvent } from 'react';
import { ArrowUp, CornerDownRight, Loader2, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
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
  /**
   * `inline`: text and a round send button on one row. `stacked`: the text
   * above a row with `+` (tag a record) and a rounded-square send button
   * (the WeldAgent panel and the agent page).
   */
  variant?: 'inline' | 'stacked';
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
  variant = 'inline',
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

  const stacked = variant === 'stacked';
  const focusField = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('button')) textareaRef.current?.focus();
  };

  /** The `+` button: writes an `@` at the caret, which opens the record picker. */
  const startTag = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const before = value.slice(0, start);
    // A tag starts the text or follows a space.
    const insert = before && !/\s$/.test(before) ? ' @' : '@';
    onChange(before + insert + value.slice(ta.selectionEnd ?? start));
    const caret = start + insert.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caret, caret);
      tags.sync(ta);
    });
  };

  const field = (
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
      className={
        stacked
          ? 'max-h-[200px] min-h-[40px] w-full flex-1 resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent pb-3 pl-[10px] pt-[7px] text-[15px] text-gray-900 outline-none placeholder:text-gray-500 dark:text-foreground dark:placeholder:text-muted-foreground'
          : 'max-h-[200px] min-h-[36px] flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70'
      }
      style={stacked ? { scrollbarWidth: 'thin', scrollbarColor: 'rgba(200,200,200,0.3) transparent' } : undefined}
    />
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn('w-full', className)}
    >
      {stacked ? (
        <div
          role="presentation"
          className={cn(
            'relative flex w-full cursor-text flex-col rounded-[20px] border border-gray-200 bg-white p-[10px]',
            'shadow-[0_1px_4px_-1px_rgba(0,0,0,0.03)] dark:border-border dark:bg-background',
            disabled && 'opacity-60',
          )}
          onClick={focusField}
        >
          {tags.menu}
          {field}
          <div className="mt-auto flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={startTag}
              aria-label={t.mentions.label}
              title={t.mentions.label}
              className="size-8 rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground"
            >
              <Plus className="h-[18px] w-[18px]" />
            </Button>
            <button
              type="submit"
              disabled={!canSubmit}
              aria-label={t.send}
              title={t.send}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-[12px] transition-all',
                canSubmit
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'cursor-not-allowed bg-gray-300 text-gray-500 dark:bg-muted dark:text-muted-foreground',
              )}
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
                  className="h-[15px] w-[15px]"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
                </svg>
              )}
            </button>
          </div>
        </div>
      ) : (
        <div
          role="presentation"
          className={cn(
            'relative flex cursor-text items-end gap-2 rounded-2xl border bg-background py-2 pl-4 pr-2',
            'shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors focus-within:border-foreground/25',
            disabled && 'opacity-60',
          )}
          onClick={focusField}
        >
          {tags.menu}
          {field}
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
      )}
    </form>
  );
}

interface AgentSuggestionsProps {
  suggestions?: string[];
  onSelect: (suggestion: string) => void;
  disabled?: boolean;
}

export function AgentSuggestions({ suggestions, onSelect, disabled = false }: Readonly<AgentSuggestionsProps>) {
  const items = suggestions ?? getDefaultAgentSuggestions();
  return (
    <div className="space-y-0.5">
      {items.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(suggestion)}
          className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
        >
          <CornerDownRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
          {suggestion}
        </button>
      ))}
    </div>
  );
}

interface AgentComposerProps extends AgentChatInputProps {
  /** Shown above the input while it is empty; picking one sends it. */
  suggestions?: string[];
}

/** The composer as on Home: the input with suggestions above it, gone once something is typed. */
export function AgentComposer({ suggestions = [], className, ...input }: Readonly<AgentComposerProps>) {
  const showSuggestions = suggestions.length > 0 && !input.value.trim();
  return (
    <div className={cn('w-full', className)}>
      {showSuggestions && (
        <div className="mb-3">
          <AgentSuggestions
            suggestions={suggestions}
            onSelect={input.onSubmit}
            disabled={input.disabled || input.isSending}
          />
        </div>
      )}
      <AgentChatInput {...input} />
    </div>
  );
}
