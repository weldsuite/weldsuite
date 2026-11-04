import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { ApprovalAnswer, ReviewItem } from '@weldsuite/app-api-client/domains/flow-approvals';
import { useI18n } from '@/lib/i18n/provider';
import { useDecideReview } from '@/hooks/queries/use-flow-approvals-queries';
import { answersFor, decideFormSchema, noteRequired, ruleText, type DecideFormValues } from '@/app/weldflow/_approvals/lib';
import { formatDate, formatMoney } from '@/app/weldflow/_approvals/format';

interface ReviewDetailProps {
  review: ReviewItem;
  nameOf: (userId: string | null | undefined) => string;
  onClose: () => void;
  /** Answered reviews (Done) and other people's rows show no answer form. */
  readOnly?: boolean;
}

const DECISION_BUTTON: Record<ApprovalAnswer, { key: 'approve' | 'approveConditions' | 'decline' | 'askInfo'; variant: 'default' | 'outline' | 'destructive' }> = {
  approved: { key: 'approve', variant: 'default' },
  approved_with_conditions: { key: 'approveConditions', variant: 'outline' },
  rejected: { key: 'decline', variant: 'destructive' },
  info_requested: { key: 'askInfo', variant: 'outline' },
};

/** The detail of one review: why the caller was asked, what it means, who else answers, and the answer form. */
export function ReviewDetail({ review, nameOf, onClose, readOnly = false }: Readonly<ReviewDetailProps>) {
  const { t, language, format } = useI18n();
  const copy = t.flowApprovals.reviews;
  const decide = useDecideReview();
  const form = useForm<DecideFormValues>({
    resolver: zodResolver(decideFormSchema(copy.detail.commentRequired)),
    defaultValues: { decision: 'approved', note: '' },
  });

  useEffect(() => {
    form.reset({ decision: 'approved', note: '' });
  }, [review.id, form]);

  const currency = review.impacts.find((impact) => impact.kind === 'cost')?.currency ?? null;
  const why = ruleText(review.rule, copy.rules, format, (value) => formatMoney(value, currency, language));
  const canAnswer = !readOnly && review.decision === 'pending' && review.actionable;
  const answers = answersFor(review);

  const answer = (decision: ApprovalAnswer) => {
    form.setValue('decision', decision);
    void form.handleSubmit(async (values) => {
      try {
        await decide.mutateAsync({ id: review.id, decision: values.decision, note: values.note.trim() ? values.note.trim() : null });
        toast.success(copy.detail.answered);
        onClose();
      } catch (error) {
        toast.error(isApiError(error) && error.message ? error.message : copy.detail.answerFailed);
      }
    })();
  };

  const noteError = form.formState.errors.note?.message;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="review-detail">
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            {copy.types[review.type]}
            {review.code ? ` · ${review.code}` : ''}
            {review.projectName ? ` · ${format(copy.inProject, { project: review.projectName })}` : ''}
          </p>
          <h2 className="mt-0.5 text-base font-semibold leading-snug">{review.title}</h2>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={copy.detail.close} title={copy.detail.close}>
          <X aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
        {review.summary ? <p className="text-muted-foreground">{review.summary}</p> : null}

        {why ? (
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.detail.whyYou}</h3>
            <p>{why}</p>
          </section>
        ) : null}

        {review.impacts.length > 0 ? (
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.detail.impacts}</h3>
            <dl className="grid grid-cols-2 gap-2">
              {review.impacts.map((impact) => (
                <div key={impact.kind} className="rounded-md border px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{copy.impact[impact.kind]}</dt>
                  <dd className="font-medium">
                    {impact.kind === 'cost'
                      ? formatMoney(impact.value, impact.currency, language)
                      : impact.kind === 'schedule_days'
                        ? format(copy.scheduleDays, { count: String(impact.value) })
                        : String(impact.value)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {review.links.length > 0 ? (
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.detail.links}</h3>
            <ul className="space-y-1">
              {review.links.map((link) => (
                <li key={`${link.type}-${link.id}-${link.relation}`} className="flex items-center gap-2">
                  <Badge variant="outline">{copy.relation[link.relation]}</Badge>
                  <span className="truncate">{link.code ? `${link.code} ` : ''}{link.title}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {review.approvers.length > 0 ? (
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.detail.approvers}</h3>
            <ul className="space-y-2">
              {review.approvers.map((approver) => (
                <li key={approver.approvalId} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate">{nameOf(approver.approverId)}</p>
                    <p className="text-xs text-muted-foreground">
                      {approver.roleLabel ? `${approver.roleLabel} · ` : ''}
                      {format(copy.detail.step, { step: String(approver.step) })}
                      {approver.decidedAt ? ` · ${formatDate(approver.decidedAt, language)}` : ''}
                    </p>
                    {approver.note ? <p className="mt-0.5 text-xs">{approver.note}</p> : null}
                  </div>
                  <Badge variant={approver.decision === 'rejected' ? 'destructive' : approver.decision === 'pending' ? 'outline' : 'secondary'}>
                    {copy.decision[approver.decision]}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {review.source === 'timesheet' ? <p className="text-xs text-muted-foreground">{copy.detail.timesheetHint}</p> : null}
        {review.decision !== 'pending' ? (
          <p className="text-muted-foreground">{format(copy.detail.answeredAs, { decision: copy.decision[review.decision] })}</p>
        ) : null}
      </div>

      {canAnswer ? (
        <form className="space-y-2 border-t px-4 py-3" onSubmit={(event) => event.preventDefault()} noValidate>
          <label htmlFor="review-note" className="text-xs font-medium text-muted-foreground">
            {copy.detail.comment}
          </label>
          <Textarea id="review-note" rows={3} placeholder={copy.detail.commentPlaceholder} {...form.register('note')} aria-invalid={!!noteError} />
          {noteError ? (
            <p role="alert" className="text-xs text-destructive">
              {noteError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {answers.map((decision) => (
              <Button
                key={decision}
                type="button"
                size="sm"
                variant={DECISION_BUTTON[decision].variant}
                disabled={decide.isPending}
                onClick={() => answer(decision)}
                data-needs-note={noteRequired(decision) ? 'true' : undefined}
              >
                {decide.isPending && form.getValues('decision') === decision ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {copy.detail[DECISION_BUTTON[decision].key]}
              </Button>
            ))}
          </div>
        </form>
      ) : null}
    </div>
  );
}
