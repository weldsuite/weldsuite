import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import type { ChangeEffects, ChangeRequestDetail } from '@weldsuite/app-api-client/domains/flow-approvals';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useDeleteChangeRequest, useSubmitChangeRequest, useWithdrawChangeRequest } from '@/hooks/queries/use-flow-approvals-queries';
import { formatDate, formatMoney } from '@/app/weldflow/_approvals/format';

export interface ChangeAbilities {
  /** Create and edit: `projects:update` on a project the caller can write to. */
  write: boolean;
  /** Delete: `projects:delete`. */
  remove: boolean;
  /** The caller manages the project. */
  manage: boolean;
}

/** What each action of a change needs, as the routes enforce it. */
export function changeActions(change: Pick<ChangeRequestDetail, 'status' | 'requestedBy'>, abilities: ChangeAbilities, userId: string | null | undefined) {
  const open = ['draft', 'assessing', 'awaiting_approval'].includes(change.status);
  return {
    edit: abilities.write && open,
    submit: abilities.write && (change.status === 'draft' || change.status === 'assessing'),
    withdraw: abilities.write && open && (abilities.manage || (!!userId && change.requestedBy === userId)),
    remove: abilities.remove && abilities.write && (change.status === 'draft' || change.status === 'withdrawn'),
  };
}

function effectLines(effects: ChangeEffects, copy: ReturnType<typeof useI18n>["t"]["flowApprovals"]["changes"]["detail"], language: Parameters<typeof formatDate>[1], format: (t: string, v: Record<string, string | number>) => string): string[] {
  const lines: string[] = [];
  if (effects.goLive) lines.push(format(copy.goLive, { date: formatDate(effects.goLive.to, language) }));
  for (const milestone of effects.milestones) lines.push(format(copy.milestone, { name: milestone.name, date: formatDate(milestone.to, language) }));
  for (const d of effects.deliverables.moved) lines.push(format(copy.moved, { code: d.code ?? '', title: d.title }));
  for (const d of effects.deliverables.added) lines.push(format(copy.added, { title: d.title }));
  for (const d of effects.deliverables.removed) lines.push(format(copy.removed, { code: d.code ?? '', title: d.title }));
  if (effects.budget) {
    lines.push(
      format(copy.budget, {
        from: formatMoney(effects.budget.from ?? '0', effects.budget.currency, language),
        to: formatMoney(effects.budget.to ?? '0', effects.budget.currency, language),
      }),
    );
  }
  return lines;
}


function decisionBadgeVariant(decision: string): 'destructive' | 'outline' | 'secondary' {
  if (decision === 'rejected') return 'destructive';
  return decision === 'pending' ? 'outline' : 'secondary';
}

interface ChangeDetailProps {
  change: ChangeRequestDetail;
  currency: string | null;
  abilities: ChangeAbilities;
  userId: string | null | undefined;
  nameOf: (userId: string | null | undefined) => string;
  onEdit: () => void;
  onDeleted: () => void;
}

/** One change request: impact, routing, approvers, what changes once approved, and its actions. */
export function ChangeDetail({ change, currency, abilities, userId, nameOf, onEdit, onDeleted }: Readonly<ChangeDetailProps>) {
  const { t, language, format } = useI18n();
  const copy = t.flowApprovals.changes;
  const detail = copy.detail;
  const submit = useSubmitChangeRequest();
  const withdraw = useWithdrawChangeRequest();
  const remove = useDeleteChangeRequest();
  const actions = changeActions(change, abilities, userId);
  const applied = change.status === 'approved' || change.status === 'implemented';
  const lines = effectLines(change.effects, detail, language, format);

  const run = async (action: () => Promise<unknown>, success: string, after?: () => void) => {
    try {
      await action();
      toast.success(success);
      after?.();
    } catch (error) {
      toast.error(isApiError(error) && error.message ? error.message : copy.actions.failed);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="change-detail">
      <div className="flex flex-wrap items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{change.code}</p>
          <h2 className="text-base font-semibold leading-snug">{change.title}</h2>
          <p className="text-xs text-muted-foreground">{format(detail.requestedBy, { name: nameOf(change.requestedBy) })}</p>
        </div>
        <Badge variant="secondary">{copy.status[change.status]}</Badge>
        <div className="flex w-full flex-wrap gap-2">
          {actions.submit ? (
            <Button size="sm" disabled={submit.isPending} onClick={() => void run(() => submit.mutateAsync(change.id), copy.actions.submitted)}>
              {copy.submit}
            </Button>
          ) : null}
          {actions.edit ? (
            <Button size="sm" variant="outline" onClick={onEdit}>
              {copy.edit}
            </Button>
          ) : null}
          {actions.withdraw ? (
            <Button
              size="sm"
              variant="outline"
              disabled={withdraw.isPending}
              onClick={() => {
                if (window.confirm(copy.actions.confirmWithdraw)) void run(() => withdraw.mutateAsync(change.id), copy.actions.withdrawn);
              }}
            >
              {copy.withdraw}
            </Button>
          ) : null}
          {actions.remove ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(copy.actions.confirmDelete)) void run(() => remove.mutateAsync(change.id), copy.actions.deleted, onDeleted);
              }}
            >
              {copy.delete}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
        {change.description ? (
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{detail.descriptionLabel}</h3>
            <p>{change.description}</p>
          </section>
        ) : null}

        <section>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{detail.impact}</h3>
          <dl className="grid grid-cols-2 gap-2">
            <div className="rounded-md border px-3 py-2">
              <dt className="text-xs text-muted-foreground">{detail.cost}</dt>
              <dd className="font-medium">{change.costDelta === null ? '-' : formatMoney(change.costDelta, currency, language)}</dd>
            </div>
            <div className="rounded-md border px-3 py-2">
              <dt className="text-xs text-muted-foreground">{detail.schedule}</dt>
              <dd className="font-medium">{change.scheduleDeltaDays === null ? '-' : format(t.flowApprovals.reviews.scheduleDays, { count: String(change.scheduleDeltaDays) })}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{detail.routing}</h3>
          <p>
            {change.routing.route === 'board' ? detail.routeBoard : detail.routeManager}
            {' · '}
            {change.routing.overLimit ? detail.overLimit : detail.underLimits}
          </p>
          {change.routing.noBoard ? <p className="text-xs text-amber-700 dark:text-amber-400">{detail.noBoardRouted}</p> : null}
        </section>

        <section>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{detail.approvers}</h3>
          {change.approvers.length === 0 ? (
            <p className="text-muted-foreground">{detail.noApprovers}</p>
          ) : (
            <ul className="space-y-2">
              {change.approvers.map((approver) => (
                <li key={approver.approvalId} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate">{nameOf(approver.approverId)}</p>
                    {approver.roleLabel ? <p className="text-xs text-muted-foreground">{approver.roleLabel}</p> : null}
                    {approver.note ? <p className="text-xs">{approver.note}</p> : null}
                  </div>
                  <Badge variant={decisionBadgeVariant(approver.decision)}>
                    {t.flowApprovals.reviews.decision[approver.decision]}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {change.canDecide ? (
            <p className="mt-2 flex items-center gap-2 text-xs">
              {detail.decideInReviews}
              <Link href="/weldflow/reviews" className="underline">
                {detail.openReviews}
              </Link>
            </p>
          ) : null}
        </section>

        <section>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{applied ? detail.effectsDone : detail.effects}</h3>
          {lines.length === 0 ? (
            <p className="text-muted-foreground">{detail.nothing}</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {change.baselineVersion ? <p className="mt-2 text-xs text-muted-foreground">{format(detail.baseline, { version: String(change.baselineVersion) })}</p> : null}
        </section>
      </div>
    </div>
  );
}
