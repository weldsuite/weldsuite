import { useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import { cn } from '@weldsuite/ui/lib/utils';
import { toast } from 'sonner';
import { formatLabel, type MeetingToolsLabels } from '../../tools/labels';
import type { MeetingPoll, MeetingPolls } from '../../tools/use-meeting-tools';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_QUESTION_LENGTH = 200;
const MAX_OPTION_LENGTH = 100;

export interface PollsToolProps {
  polls: MeetingPolls;
  /** Only the host starts a poll; everyone votes. */
  canCreate: boolean;
  labels: MeetingToolsLabels;
}

export function PollsTool({ polls, canCreate, labels }: PollsToolProps) {
  const t = labels.polls;
  const [creating, setCreating] = useState(false);
  const allowCreate = canCreate && polls.canCreate;
  // Newest first: the poll that was just started is the one people came for.
  const ordered = [...polls.polls].reverse();

  return (
    <div className="p-4 space-y-4">
      {allowCreate && !creating && (
        <Button type="button" className="w-full" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          {t.newPoll}
        </Button>
      )}
      {allowCreate && creating && (
        <NewPollForm
          labels={labels}
          onCancel={() => setCreating(false)}
          onCreate={async (question, options, anonymous) => {
            try {
              await polls.create(question, options, anonymous);
              setCreating(false);
            } catch (err) {
              console.error('[WeldMeet] create poll failed:', err);
              toast.error(t.failed);
            }
          }}
        />
      )}

      {ordered.length === 0 && !creating && (
        <p className="text-sm text-muted-foreground">{allowCreate ? t.emptyHost : t.empty}</p>
      )}

      {ordered.map((poll) => (
        <PollCard key={poll.id} poll={poll} polls={polls} labels={labels} />
      ))}
    </div>
  );
}

function NewPollForm({
  labels,
  onCancel,
  onCreate,
}: {
  labels: MeetingToolsLabels;
  onCancel: () => void;
  onCreate: (question: string, options: string[], anonymous: boolean) => Promise<void>;
}) {
  const t = labels.polls;
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [anonymous, setAnonymous] = useState(false);
  const [saving, setSaving] = useState(false);

  const cleanOptions = options.map((option) => option.trim()).filter(Boolean);
  const valid = question.trim().length > 0 && cleanOptions.length >= MIN_OPTIONS;

  return (
    <form
      className="space-y-3 rounded-xl bg-muted/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || saving) return;
        setSaving(true);
        void onCreate(question.trim(), cleanOptions, anonymous).finally(() => setSaving(false));
      }}
    >
      <label className="block space-y-1.5">
        <span className="block text-xs font-medium text-muted-foreground">{t.question}</span>
        <Input
          autoFocus
          value={question}
          maxLength={MAX_QUESTION_LENGTH}
          placeholder={t.questionPlaceholder}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>

      <div className="space-y-2">
        {options.map((option, index) => {
          const label = formatLabel(t.option, { number: index + 1 });
          return (
            // The inputs are positional; the list only grows / shrinks at the end or by index.
            <div key={index} className="flex items-center gap-2">
              <Input
                value={option}
                maxLength={MAX_OPTION_LENGTH}
                placeholder={label}
                aria-label={label}
                onChange={(e) => setOptions(options.map((o, i) => (i === index ? e.target.value : o)))}
              />
              {options.length > MIN_OPTIONS && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.removeOption}
                  onClick={() => setOptions(options.filter((_, i) => i !== index))}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          );
        })}
        {options.length < MAX_OPTIONS && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setOptions([...options, ''])}>
            <Plus className="h-3.5 w-3.5" />
            {t.addOption}
          </Button>
        )}
      </div>

      <label className="flex items-center justify-between gap-3">
        <span className="text-sm">{t.anonymous}</span>
        <Switch checked={anonymous} onCheckedChange={setAnonymous} aria-label={t.anonymous} />
      </label>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={!valid || saving}>
          {t.create}
        </Button>
      </div>
    </form>
  );
}

function PollCard({ poll, polls, labels }: { poll: MeetingPoll; polls: MeetingPolls; labels: MeetingToolsLabels }) {
  const t = labels.polls;
  const [voting, setVoting] = useState(false);
  const hasVoted = polls.selfIds.some((id) => poll.voted?.includes(id));
  const isCreator = polls.selfIds.includes(poll.createdByUserId);
  const showResults = hasVoted || isCreator || !polls.canVote;
  const total = poll.options.reduce((sum, option) => sum + (option.count ?? 0), 0);

  const handleVote = async (index: number) => {
    if (voting || hasVoted || !polls.canVote) return;
    setVoting(true);
    try {
      await polls.vote(poll.id, index);
    } catch (err) {
      console.error('[WeldMeet] vote failed:', err);
      toast.error(t.failed);
    } finally {
      setVoting(false);
    }
  };

  return (
    <section className="space-y-2.5 rounded-xl bg-muted/40 p-3">
      <header>
        <h4 className="text-sm font-medium leading-snug">{poll.question}</h4>
        <p className="text-xs text-muted-foreground">
          {poll.createdBy ? `${formatLabel(t.createdBy, { name: poll.createdBy })} · ` : ''}
          {formatLabel(t.votes, { count: total })}
        </p>
      </header>
      <ul className="space-y-1.5">
        {poll.options.map((option, index) => {
          const count = option.count ?? 0;
          const percent = total > 0 ? Math.round((count / total) * 100) : 0;
          const mine = option.votes?.some((vote) => polls.selfIds.includes(vote.id)) ?? false;
          const canPick = !hasVoted && polls.canVote;
          return (
            // Poll options have no id of their own; their position is their identity.
            <li key={index}>
              <button
                type="button"
                disabled={!canPick || voting}
                onClick={() => void handleVote(index)}
                title={mine ? t.yourVote : undefined}
                className={cn(
                  'relative w-full overflow-hidden rounded-lg border bg-background/60 px-3 py-2 text-left text-sm transition-colors',
                  canPick && 'hover:bg-muted cursor-pointer',
                  !canPick && 'cursor-default',
                  mine && 'border-primary',
                )}
              >
                {showResults && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-primary/15 transition-[width]"
                    style={{ width: `${percent}%` }}
                  />
                )}
                <span className="relative flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {mine && <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-label={t.yourVote} />}
                    <span className="truncate">{option.text}</span>
                  </span>
                  {showResults && (
                    <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground">
                      {count} · {percent}%
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
