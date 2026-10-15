import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Building2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { TableCell, TableRow } from '@weldsuite/ui/components/table';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { CaseCard } from '@/components/outbound-mail/case-card';
import { LiveUnavailable } from '@/components/outbound-mail/live';
import { RiskScore, StateBadge } from '@/components/outbound-mail/parts';
import { PolicyForm } from '@/components/outbound-mail/policy-form';
import { RequestReviewButton } from '@/components/outbound-mail/review-button';
import { EmptyRow, Section, Stat, TableFrame, Th } from '@/components/warmup/parts';
import { formatDate } from '@/app/workspaces/workspace-presentation';
import { requireAdmin } from '@/lib/auth';
import { formatDateTime } from '@/lib/billing-format';
import { isMailApiConfigured, loadOutboundInspect, type OutboundInspect } from '@/lib/mail-api';
import {
  DEFAULT_POLICY,
  actorLabel,
  LIMIT_FIELDS,
  LIMIT_KEYS,
  STATE_LABELS,
  TRUST_LABELS,
  denialLabel,
  describeRiskReason,
  eventKindLabel,
  eventValueLabel,
  guardModeLabel,
  pickPolicySnapshot,
  riskTone,
  trustDisplay,
  type OutboundTrustLevel,
} from '@/lib/outbound-mail';
import {
  getOutboundWorkspace,
  listWorkspaceCases,
  listWorkspaceEvents,
  type OutboundPolicyDetail,
} from '@/lib/outbound-mail-data';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const number = (n: number) => n.toLocaleString('en-GB');

function againstLimit(used: number, limit: number | null): string {
  return limit === null ? number(used) : `${number(used)} / ${number(limit)}`;
}

function over(used: number, limit: number | null): boolean {
  return limit !== null && used >= limit;
}

/** Usage, risk and shadow-mode denials as the ledger has them right now. */
function LiveView({ live }: Readonly<{ live: OutboundInspect }>) {
  const { usage } = live;
  const denials = Object.entries(live.shadowDenials7d)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const deliveries = usage.deliveries7d;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Guard mode" value={guardModeLabel(usage.mode)} />
        <Stat
          label="Recipients, 24 h"
          value={againstLimit(usage.workspace.day.used, usage.workspace.day.limit)}
          tone={over(usage.workspace.day.used, usage.workspace.day.limit) ? 'warning' : 'default'}
          hint={`${number(usage.workspace.hour)} this hour`}
        />
        <Stat
          label="First contact, 24 h"
          value={againstLimit(usage.workspace.firstContactDay.used, usage.workspace.firstContactDay.limit)}
          tone={over(usage.workspace.firstContactDay.used, usage.workspace.firstContactDay.limit) ? 'warning' : 'default'}
          hint={usage.coldOutreachCapped ? 'A template is capped as cold outreach today' : 'No template capped today'}
        />
        <Stat
          label="This month"
          value={againstLimit(usage.workspace.month.used, usage.workspace.month.limit)}
          hint={usage.workspace.month.limit === null ? 'No monthly cap' : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            Risk score <RiskScore score={live.riskScore} className="ml-1" />
          </h3>
          {live.riskReasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing adds to the score right now.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {live.riskReasons.map((reason) => (
                <li key={reason}>{describeRiskReason(reason)}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Delivery, last 7 days</h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Delivered</dt>
            <dd className="tabular-nums">{number(deliveries.delivered)}</dd>
            <dt className="text-muted-foreground">Hard bounces</dt>
            <dd className={cn('tabular-nums', deliveries.hardBounces > 0 && 'text-amber-600 dark:text-amber-400')}>
              {number(deliveries.hardBounces)}
            </dd>
            <dt className="text-muted-foreground">Soft bounces</dt>
            <dd className="tabular-nums">{number(deliveries.softBounces)}</dd>
            <dt className="text-muted-foreground">Complaints</dt>
            <dd className={cn('tabular-nums', deliveries.complaints > 0 && 'font-medium text-destructive')}>
              {number(deliveries.complaints)}
            </dd>
            <dt className="text-muted-foreground">Rejected</dt>
            <dd className="tabular-nums">{number(deliveries.rejected)}</dd>
          </dl>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Limits in force</h3>
          <TableFrame
            head={
              <>
                <Th>Limit</Th>
                <Th right>Recipients</Th>
              </>
            }
          >
            {LIMIT_KEYS.map((key) => {
              const value = usage.limits[key];
              return (
                <TableRow key={key} className="h-9">
                  <TableCell className="py-1.5 text-sm">{LIMIT_FIELDS[key].label}</TableCell>
                  <TableCell className="py-1.5 text-right text-sm tabular-nums">{value === null ? 'No cap' : number(value)}</TableCell>
                </TableRow>
              );
            })}
          </TableFrame>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Would have been refused, last 7 days</h3>
          <p className="text-xs text-muted-foreground">
            {usage.mode === 'shadow'
              ? 'The guard is in shadow mode: these sends went out, but enforcing would have refused them.'
              : 'Counted while the guard ran in shadow mode.'}
          </p>
          <TableFrame
            head={
              <>
                <Th>Reason</Th>
                <Th right>Sends</Th>
              </>
            }
          >
            {denials.length === 0 && <EmptyRow colSpan={2}>None.</EmptyRow>}
            {denials.map(([code, count]) => (
              <TableRow key={code} className="h-9">
                <TableCell className="py-1.5 text-sm" title={code}>
                  {denialLabel(code)}
                </TableCell>
                <TableCell className="py-1.5 text-right text-sm tabular-nums">{number(count)}</TableCell>
              </TableRow>
            ))}
          </TableFrame>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Senders, last 24 hours</h3>
        <TableFrame
          head={
            <>
              <Th>Address</Th>
              <Th right>This hour</Th>
              <Th right>24 hours</Th>
            </>
          }
        >
          {usage.senders.length === 0 && <EmptyRow colSpan={3}>No mail sent in the last 24 hours.</EmptyRow>}
          {usage.senders.map((sender) => (
            <TableRow key={sender.email} className="h-9">
              <TableCell className="py-1.5 text-sm">{sender.email}</TableCell>
              <TableCell
                className={cn('py-1.5 text-right text-sm tabular-nums', over(sender.hour.used, sender.hour.limit) && 'text-amber-600 dark:text-amber-400')}
              >
                {againstLimit(sender.hour.used, sender.hour.limit)}
              </TableCell>
              <TableCell
                className={cn('py-1.5 text-right text-sm tabular-nums', over(sender.day.used, sender.day.limit) && 'text-amber-600 dark:text-amber-400')}
              >
                {againstLimit(sender.day.used, sender.day.limit)}
              </TableCell>
            </TableRow>
          ))}
        </TableFrame>
      </div>
    </div>
  );
}

/** State, trust, stored risk and open cases, with who set the state and the reason the customer sees. */
function Summary({
  policy,
  trustLevel,
  computedTrust,
  openCases,
}: Readonly<{
  policy: OutboundPolicyDetail | null;
  /** The level the live ledger applies; null without live data. */
  trustLevel: OutboundTrustLevel | null;
  computedTrust: OutboundTrustLevel;
  openCases: number;
}>) {
  const snapshot = policy ?? DEFAULT_POLICY;
  const trustSource = snapshot.trustOverride ? 'set by staff' : 'computed';
  const trustLabel = trustLevel
    ? `${TRUST_LABELS[trustLevel]} (${trustSource})`
    : trustDisplay(snapshot.trustOverride, computedTrust).label;
  const storedRisk = policy?.riskScore ?? 0;
  const setBy = actorLabel(policy?.stateSetBy);
  const byText = setBy ? ` by ${setBy}` : '';
  const stateSetLine = policy?.stateSetAt ? `Set ${formatDateTime(policy.stateSetAt)}${byText}` : 'Never changed';
  const tone = riskTone(storedRisk);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="State"
          value={STATE_LABELS[snapshot.state]}
          tone={snapshot.state === 'active' ? 'default' : 'warning'}
          hint={stateSetLine}
        />
        <Stat label="Trust level" value={trustLabel} />
        <Stat
          label="Risk score (stored)"
          value={String(storedRisk)}
          tone={tone === 'high' || tone === 'critical' ? 'warning' : 'default'}
          hint={policy?.riskUpdatedAt ? `Saved ${formatDateTime(policy.riskUpdatedAt)}` : 'Not scored yet'}
        />
        <Stat label="Open cases" value={number(openCases)} tone={openCases > 0 ? 'warning' : 'default'} />
      </div>

      {snapshot.state !== 'active' && (
        <p className="text-sm">
          <span className="text-muted-foreground">Reason shown to the customer: </span>
          {snapshot.stateReason ? (
            <span className="italic">“{snapshot.stateReason}”</span>
          ) : (
            <span className="text-muted-foreground">none</span>
          )}
        </p>
      )}
    </>
  );
}

export default async function OutboundWorkspacePage(props: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const identity = await requireAdmin();
  const { workspaceId } = await props.params;

  const found = await getOutboundWorkspace(workspaceId);
  if (!found) notFound();
  const { workspace, policy } = found;

  const [live, cases, events] = await Promise.all([
    loadOutboundInspect(identity, workspace.id),
    listWorkspaceCases(workspace.id),
    listWorkspaceEvents(workspace.id),
  ]);

  // Policy changes need a live workspace; case reviews stay open for a deleted one (they are labelled data).
  const canReview = identity.role !== 'viewer';
  const canWrite = canReview && !workspace.deleted;
  const snapshot = pickPolicySnapshot(policy ?? DEFAULT_POLICY);
  // Without an override the live level is the computed one, with the ledger's bounce and complaint record.
  const computedTrust = !snapshot.trustOverride && live.kind === 'ok' ? live.data.usage.trustLevel : workspace.computedTrust;

  return (
    <PageContent>
      <PageBody className="space-y-8">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-muted-foreground">
            <Link href="/outbound-mail">
              <ArrowLeft className="h-4 w-4" />
              Outbound mail
            </Link>
          </Button>

          <PageHeading
            title={workspace.name}
            description={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs">{workspace.slug}</span>
                <span aria-hidden>·</span>
                <span className="text-xs">{workspace.planName ?? 'no plan'}</span>
                <span aria-hidden>·</span>
                <span className="text-xs">created {formatDate(workspace.createdAt, false)}</span>
                <span aria-hidden>·</span>
                <Link
                  href={`/workspaces/${workspace.id}`}
                  className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                >
                  <Building2 className="h-3.5 w-3.5" />
                  Workspace page
                </Link>
                {workspace.deleted && <span className="text-xs text-destructive">deleted</span>}
              </span>
            }
            actions={
              <>
                <StateBadge state={snapshot.state} />
                {canWrite && <RequestReviewButton workspaceId={workspace.id} disabled={!isMailApiConfigured()} />}
              </>
            }
          />
        </div>

        <Summary
          policy={policy}
          trustLevel={live.kind === 'ok' ? live.data.usage.trustLevel : null}
          computedTrust={workspace.computedTrust}
          openCases={cases.filter((row) => row.status === 'open').length}
        />

        <Section title="Live" note="From the workspace's ledger in mail-api">
          {live.kind === 'ok' ? <LiveView live={live.data} /> : <LiveUnavailable state={live} />}
        </Section>

        <Section
          title="Policy"
          note={policy ? 'Blank limit fields use the defaults of the trust level' : 'No policy row yet: the defaults apply'}
        >
          <PolicyForm
            // Remount when the stored policy changes (a save), not when the guard only refreshes the risk score.
            key={JSON.stringify(snapshot)}
            workspaceId={workspace.id}
            policy={snapshot}
            computedTrust={computedTrust}
            canWrite={canWrite}
          />
        </Section>

        <Section title="Cases" note={cases.length > 0 ? 'Newest first' : undefined}>
          {cases.length === 0 ? (
            <p className="rounded-lg border py-8 text-center text-sm text-muted-foreground">No cases for this workspace.</p>
          ) : (
            <div className="space-y-3">
              {cases.map((row) => (
                <CaseCard key={row.id} row={row} canWrite={canReview} linkWorkspace={false} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Trail" note="State, trust, limit and case changes, automatic and by staff. Kept for a year.">
          <TableFrame
            head={
              <>
                <Th>When</Th>
                <Th>Change</Th>
                <Th>From</Th>
                <Th>To</Th>
                <Th>Reason</Th>
                <Th>By</Th>
              </>
            }
          >
            {events.length === 0 && <EmptyRow colSpan={6}>Nothing recorded yet.</EmptyRow>}
            {events.map((event) => (
              <TableRow key={event.id} className="h-10 hover:bg-muted/50">
                <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">{formatDateTime(event.createdAt)}</TableCell>
                <TableCell className="py-2 text-sm">{eventKindLabel(event.kind)}</TableCell>
                <TableCell className="py-2 text-xs">{eventValueLabel(event.kind, event.fromValue)}</TableCell>
                <TableCell className="py-2 text-xs">{eventValueLabel(event.kind, event.toValue)}</TableCell>
                <TableCell className="max-w-sm py-2 text-xs">{event.reason ?? '—'}</TableCell>
                <TableCell className="py-2 text-xs">{event.actor === 'system' ? 'Guard' : event.actor}</TableCell>
              </TableRow>
            ))}
          </TableFrame>
        </Section>
      </PageBody>
    </PageContent>
  );
}
