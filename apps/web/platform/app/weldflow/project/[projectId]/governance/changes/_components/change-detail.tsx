/**
 * The two tabs of a change request's panel, flush sections divided by a line:
 * Details (status, who and when, impact and routing, what changes once it is
 * approved) and Approvals (who has been asked and what they answered).
 */

import type { ReactNode } from 'react';
import type { ChangeEffects, ChangeRequest, ChangeRequestDetail } from '@weldsuite/app-api-client/domains/flow-approvals';
import { ListCode } from '@/app/weldflow/components/list-cells';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { formatDate, formatMoney } from '@/app/weldflow/_approvals/format';
import { ChangeStatusPill, DecisionPill, useRouteLabel } from './change-status';

export interface ChangeAbilities {
  /** Create and edit: `projects:update` on a project the caller can write to. */
  write: boolean;
  /** Delete: `projects:delete`. */
  remove: boolean;
  /** The caller manages the project. */
  manage: boolean;
}

/** What each action of a change needs, as the routes enforce it. */
export function changeActions(change: Pick<ChangeRequest, 'status' | 'requestedBy'>, abilities: ChangeAbilities, userId: string | null | undefined) {
  const open = ['draft', 'assessing', 'awaiting_approval'].includes(change.status);
  return {
    edit: abilities.write && open,
    submit: abilities.write && (change.status === 'draft' || change.status === 'assessing'),
    withdraw: abilities.write && open && (abilities.manage || (!!userId && change.requestedBy === userId)),
    remove: abilities.remove && abilities.write && (change.status === 'draft' || change.status === 'withdrawn'),
  };
}

/** What the caller may do to one change: edit, submit, withdraw, delete. */
export type ChangeAllowed = ReturnType<typeof changeActions>;

type Copy = ReturnType<typeof useI18n>['t']['flowApprovals']['changes'];
type Language = ReturnType<typeof useI18n>['language'];
type Format = ReturnType<typeof useI18n>['format'];

/** What the change moves once approved, one line each: the go-live, milestones, deliverables and the budget. */
function effectLines(effects: ChangeEffects, copy: Copy['detail'], language: Language, format: Format): string[] {
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

/** A block of a tab: edge to edge, divided from the next by a line. */
function Section({ title, children }: Readonly<{ title?: string; children: ReactNode }>) {
  return (
    <section className="border-b border-border px-6 py-5 last:border-b-0">
      {title ? <h2 className="mb-3 text-sm font-semibold">{title}</h2> : null}
      {children}
    </section>
  );
}

function Facts({ children }: Readonly<{ children: ReactNode }>) {
  return <dl className="m-0 grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">{children}</dl>;
}

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

interface ChangeTabProps {
  change: ChangeRequestDetail;
  nameOf: (userId: string | null | undefined) => string;
}

/** Details tab: the status, the description, who asked and when, the impact and routing, and what changes once approved. */
export function ChangeDetailsTab({ change, currency, nameOf }: Readonly<ChangeTabProps & { currency: string | null }>) {
  const { t, language, format } = useI18n();
  const copy = t.flowApprovals.changes;
  const detail = copy.detail;
  const routeLabel = useRouteLabel();
  const applied = change.status === 'approved' || change.status === 'implemented';
  const lines = effectLines(change.effects, detail, language, format);
  const requester = change.requestedByName ?? (change.requestedBy ? nameOf(change.requestedBy) : null);

  return (
    <div data-testid="change-detail">
      <Section>
        <div className="flex flex-wrap items-center gap-2">
          <ListCode code={change.code} />
          <ChangeStatusPill status={change.status} />
        </div>
      </Section>

      {change.description ? (
        <Section title={detail.descriptionLabel}>
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/80">{change.description}</p>
        </Section>
      ) : null}

      <Section>
        <Facts>
          <Fact label={copy.columns.requestedBy}>{requester ?? '—'}</Fact>
          <Fact label={detail.submitted}>{change.submittedAt ? formatDate(change.submittedAt, language) : '—'}</Fact>
          {change.decidedAt ? <Fact label={detail.decided}>{formatDate(change.decidedAt, language)}</Fact> : null}
        </Facts>
      </Section>

      <Section title={detail.impact}>
        <Facts>
          <Fact label={detail.cost}>{change.costDelta === null ? '—' : formatMoney(change.costDelta, currency, language)}</Fact>
          <Fact label={detail.schedule}>
            {change.scheduleDeltaDays === null ? '—' : format(t.flowApprovals.reviews.scheduleDays, { count: String(change.scheduleDeltaDays) })}
          </Fact>
          <Fact label={detail.routing}>
            {routeLabel(change.routing.route)}
            {' · '}
            {change.routing.overLimit ? detail.overLimit : detail.underLimits}
            {change.routing.noBoard ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{detail.noBoardRouted}</p> : null}
          </Fact>
        </Facts>
      </Section>

      <Section title={applied ? detail.effectsDone : detail.effects}>
        {lines.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{detail.nothing}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-[13px]">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {change.baselineVersion ? <p className="mt-3 text-xs text-muted-foreground">{format(detail.baseline, { version: String(change.baselineVersion) })}</p> : null}
      </Section>
    </div>
  );
}

/** Approvals tab: who has been asked, in what role, what they answered and why. */
export function ChangeApprovalsTab({ change, nameOf }: Readonly<ChangeTabProps>) {
  const { t } = useI18n();
  const detail = t.flowApprovals.changes.detail;

  return (
    <div data-testid="change-approvals">
      {change.approvers.length === 0 ? (
        <p className="px-6 py-5 text-[13px] text-muted-foreground">{detail.noApprovers}</p>
      ) : (
        <ul>
          {change.approvers.map((approver) => (
            <li key={approver.approvalId} className="flex items-start justify-between gap-3 border-b border-border px-6 py-3 text-[13px]">
              <div className="min-w-0">
                <p className="truncate font-medium">{nameOf(approver.approverId)}</p>
                {approver.roleLabel ? <p className="text-xs text-muted-foreground">{approver.roleLabel}</p> : null}
                {approver.note ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-foreground/80">{approver.note}</p> : null}
              </div>
              <DecisionPill decision={approver.decision} />
            </li>
          ))}
        </ul>
      )}
      {change.canDecide ? (
        <p className="flex flex-wrap items-center gap-x-2 px-6 py-4 text-[13px]">
          {detail.decideInReviews}
          <Link href="/weldflow/reviews" className="underline underline-offset-2">
            {detail.openReviews}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
