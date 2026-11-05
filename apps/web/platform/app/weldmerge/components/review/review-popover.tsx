import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { MergeReviewEvent } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { useI18n } from '@/lib/i18n/provider';
import { fill } from '../../lib/format';

interface ReviewPopoverProps {
  pendingCount: number;
  submitting: boolean;
  /** Resolves when the review went through; rejects (after reporting) when it did not. */
  onSubmit: (event: MergeReviewEvent, body: string) => Promise<void>;
}

const EVENTS: readonly MergeReviewEvent[] = ['comment', 'approve', 'request_changes'];

/** The Review changes popover: a summary, the decision, and the pending line comments that go with it. */
export function ReviewPopover({ pendingCount, submitting, onSubmit }: Readonly<ReviewPopoverProps>) {
  const { t } = useI18n();
  const tr = t.weldmerge.reviewing.review;
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<MergeReviewEvent>('comment');
  const [body, setBody] = useState('');

  const labels: Record<MergeReviewEvent, { label: string; hint: string }> = {
    comment: { label: tr.comment, hint: tr.commentHint },
    approve: { label: tr.approve, hint: tr.approveHint },
    request_changes: { label: tr.requestChanges, hint: tr.requestChangesHint },
  };
  // The API wants a note on a review that carries nothing else.
  const needsBody = event !== 'approve' && pendingCount === 0 && body.trim() === '';

  const submit = async () => {
    try {
      await onSubmit(event, body.trim());
      setBody('');
      setEvent('comment');
      setOpen(false);
    } catch {
      // Reported by the page; the popover stays open with what was typed.
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button>
          {tr.button}
          {pendingCount > 0 && (
            <span className="rounded-full bg-primary-foreground/20 px-1.5 text-xs tabular-nums" aria-hidden>
              {pendingCount}
            </span>
          )}
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] space-y-3">
        <p className="text-sm font-semibold">{tr.title}</p>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={tr.summaryPlaceholder}
          aria-label={tr.summaryLabel}
          rows={4}
        />
        <RadioGroup value={event} onValueChange={(value) => setEvent(value as MergeReviewEvent)} className="gap-2">
          {EVENTS.map((value) => (
            <div key={value} className="flex items-start gap-2">
              <RadioGroupItem id={`review-event-${value}`} value={value} className="mt-0.5" />
              <Label htmlFor={`review-event-${value}`} className="flex-col items-start gap-0.5">
                <span>{labels[value].label}</span>
                <span className="text-xs font-normal text-muted-foreground">{labels[value].hint}</span>
              </Label>
            </div>
          ))}
        </RadioGroup>
        {pendingCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {pendingCount === 1 ? tr.pendingCommentsOne : fill(tr.pendingComments, { count: pendingCount })}
          </p>
        )}
        {needsBody && <p className="text-xs text-muted-foreground">{tr.bodyRequired}</p>}
        <div className="flex justify-end">
          <Button disabled={needsBody || submitting} onClick={() => void submit()}>
            {tr.submit}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
