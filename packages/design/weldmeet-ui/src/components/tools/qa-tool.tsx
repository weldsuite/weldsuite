import { useState } from 'react';
import { Check, ChevronUp, RotateCcw, Send, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@weldsuite/ui/lib/utils';
import { formatLabel, type MeetingToolsLabels } from '../../tools/labels';
import {
  questionVoteCount,
  sortedQuestions,
  type MeetingToolsStore,
  type QaQuestion,
} from '../../tools/tools-store';

const MAX_QUESTION_LENGTH = 500;

export interface QaToolProps {
  store: MeetingToolsStore;
  questions: QaQuestion[];
  /** The host marks questions answered and removes them; everyone asks and upvotes. */
  canModerate: boolean;
  labels: MeetingToolsLabels;
}

export function QaTool({ store, questions, canModerate, labels }: QaToolProps) {
  const t = labels.qa;
  const [draft, setDraft] = useState('');
  const selfKey = store.selfKey;
  const visible = sortedQuestions(questions);

  const submit = () => {
    if (!draft.trim()) return;
    store.askQuestion(draft);
    setDraft('');
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-4">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.empty}</p>
        ) : (
          <ul className="space-y-2">
            {visible.map((question) => {
              const votes = questionVoteCount(question);
              const voted = question.votes[selfKey]?.on === true;
              const own = question.authorKey === selfKey;
              return (
                <li
                  key={question.id}
                  className={cn('flex gap-2.5 rounded-xl bg-muted/40 p-3', question.answered && 'opacity-60')}
                >
                  <button
                    type="button"
                    onClick={() => store.toggleQuestionVote(question.id)}
                    aria-label={t.upvote}
                    aria-pressed={voted}
                    title={t.upvote}
                    className={cn(
                      'flex h-11 w-9 flex-shrink-0 flex-col items-center justify-center rounded-lg border bg-background/60 text-xs font-medium tabular-nums transition-colors hover:bg-muted',
                      voted && 'border-primary text-primary',
                    )}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                    {votes}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-sm leading-snug">{question.text}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>{formatLabel(t.askedBy, { name: question.authorName })}</span>
                      {question.answered && (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <Check className="h-3 w-3" />
                          {t.answered}
                        </span>
                      )}
                    </p>
                  </div>
                  {(canModerate || own) && (
                    <div className="flex flex-shrink-0 items-start gap-0.5">
                      {canModerate && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={question.answered ? t.markOpen : t.markAnswered}
                          title={question.answered ? t.markOpen : t.markAnswered}
                          onClick={() => store.setQuestionAnswered(question.id, !question.answered)}
                        >
                          {question.answered ? <RotateCcw /> : <Check />}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t.remove}
                        title={t.remove}
                        onClick={() => store.removeQuestion(question.id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form
        className="flex flex-shrink-0 items-center gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          value={draft}
          maxLength={MAX_QUESTION_LENGTH}
          placeholder={t.placeholder}
          aria-label={t.placeholder}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          <Send className="h-3.5 w-3.5" />
          {t.ask}
        </Button>
      </form>
    </div>
  );
}
