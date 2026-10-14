import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, PencilLine } from 'lucide-react';
import {
  answerFromOptions,
  type AgentQuestion,
} from '@weldsuite/app-api-client/schemas/weldagent-questions';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';

interface QuestionCardProps {
  question: AgentQuestion;
  /** Only the latest unanswered question takes clicks and number keys. */
  active: boolean;
  /** The reply the user gave, once answered. */
  answer?: string | null;
  disabled?: boolean;
  onAnswer: (text: string) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * A question the agent asked with `ask_user`: its options as rows (number keys
 * pick them), plus a row to type a different answer. Once answered it shrinks
 * to the question and the answer given.
 */
export function QuestionCard({ question, active, answer, disabled, onAnswer }: Readonly<QuestionCardProps>) {
  const t = getTranslations('common').agents.detail.questions;
  const [selected, setSelected] = useState<string[]>([]);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const multi = question.multiSelect === true;
  const interactive = active && !disabled;

  const pick = (label: string) => {
    if (!interactive) return;
    if (!multi) {
      onAnswer(label);
      return;
    }
    setSelected((prev) => (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]));
  };

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || !interactive) return;
    onAnswer(text);
  };

  useEffect(() => {
    if (writing) inputRef.current?.focus();
  }, [writing]);

  // Number keys pick an option while the user isn't typing somewhere.
  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const index = Number.parseInt(e.key, 10) - 1;
      const option = question.options[index];
      if (!option) return;
      e.preventDefault();
      pick(option.label);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (answer != null) {
    return (
      <div className="rounded-xl border border-border/70 px-3.5 py-2.5 text-[13px]">
        <p className="text-muted-foreground">{question.question}</p>
        <p className="mt-1 flex items-start gap-1.5 font-medium text-foreground">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span className="min-w-0 break-words">{answer}</span>
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-card shadow-sm',
        !active && 'opacity-60',
      )}
      role="group"
      aria-label={question.question}
    >
      <div className="px-4 pt-3.5 pb-2">
        <p className="text-[15px] font-medium leading-snug text-foreground">{question.question}</p>
        {multi && <p className="mt-0.5 text-xs text-muted-foreground">{t.multiHint}</p>}
      </div>

      <div className="px-1.5 pb-1.5">
        {question.options.map((option, index) => {
          const isSelected = selected.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              disabled={!interactive}
              onClick={() => pick(option.label)}
              className={cn(
                'group flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                isSelected && 'bg-accent',
                !interactive && 'pointer-events-none',
              )}
            >
              <span
                className={cn(
                  'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-medium tabular-nums',
                  isSelected
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground group-hover:border-foreground/40',
                )}
              >
                {isSelected ? <Check className="h-3 w-3" strokeWidth={3} /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm leading-snug text-foreground">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        {writing ? (
          <form
            className="flex items-center gap-2 px-2.5 py-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              submitDraft();
            }}
          >
            <PencilLine className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={draft}
              disabled={!interactive}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setWriting(false);
                  setDraft('');
                }
              }}
              placeholder={t.otherPlaceholder}
              className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground/70"
            />
            <button
              type="submit"
              disabled={!draft.trim() || !interactive}
              aria-label={t.send}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-30"
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          </form>
        ) : (
          <button
            type="button"
            disabled={!interactive}
            onClick={() => setWriting(true)}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none',
              !interactive && 'pointer-events-none',
            )}
          >
            <PencilLine className="ml-0.5 h-4 w-4 shrink-0" />
            {t.other}
          </button>
        )}
      </div>

      {multi && (
        <div className="flex items-center justify-end border-t px-3 py-2">
          <button
            type="button"
            disabled={!interactive || selected.length === 0}
            onClick={() => onAnswer(answerFromOptions(selected))}
            className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition-opacity disabled:opacity-30"
          >
            {t.continue}
          </button>
        </div>
      )}
    </div>
  );
}
