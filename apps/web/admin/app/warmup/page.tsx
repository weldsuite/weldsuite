import Link from 'next/link';
import { Flame, Search, TriangleAlert } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { TableCell, TableRow } from '@weldsuite/ui/components/table';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { MailboxWarmupActions } from '@/components/warmup/mailbox-actions';
import {
  EmptyRow,
  GroupTable,
  PoolStatusBadge,
  RateText,
  Section,
  Stat,
  TableFrame,
  Th,
} from '@/components/warmup/parts';
import { requireAdmin } from '@/lib/auth';
import { formatDateTime } from '@/lib/billing-format';
import { cn } from '@/lib/utils';
import {
  PARTICIPATING_STATUSES,
  POOL_STATUSES,
  STALLED_STATUSES,
  WARMUP_MIN_INBOX_RATE,
  WARMUP_MIN_POOL_DOMAINS,
  formatRate,
  placementShare,
  poolDomainsFlag,
  shortenError,
  stalledReason,
  sumPlacement,
  type PoolStatus,
} from '@/lib/warmup-network';
import {
  MAILBOX_TABLE_LIMIT,
  TREND_DAYS,
  getPlacementTrend,
  getPoolOverview,
  getTodayVolume,
  listPoolMailboxes,
  listProblemMailboxes,
} from '@/lib/warmup-network-data';

export const dynamic = 'force-dynamic';

type SearchParams = { q?: string };

const number = (n: number) => n.toLocaleString('en-GB');

const sumStatuses = (counts: Record<PoolStatus, number>, statuses: readonly PoolStatus[]) =>
  statuses.reduce((sum, status) => sum + counts[status], 0);

export default async function WarmupNetworkPage(props: Readonly<{ searchParams?: Promise<SearchParams> }>) {
  const identity = await requireAdmin();
  const searchParams = (await props.searchParams) ?? {};
  const q = (searchParams.q ?? '').trim().slice(0, 100);
  const canWrite = identity.role !== 'viewer';

  const [overview, today, trend, problems, mailboxes] = await Promise.all([
    getPoolOverview(),
    getTodayVolume(),
    getPlacementTrend(),
    listProblemMailboxes(),
    listPoolMailboxes(q),
  ]);

  const flag = poolDomainsFlag(overview.participatingDomains);
  const taking = sumStatuses(overview.byStatus, PARTICIPATING_STATUSES);
  const stalled = sumStatuses(overview.byStatus, STALLED_STATUSES);
  const week = sumPlacement(trend);
  const weekRate = placementShare(week);

  return (
    <PageContent>
      <PageBody className="space-y-8">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <Flame className="h-6 w-6 text-primary" />
              Warmup network
            </span>
          }
          description="WeldReach mailboxes from every workspace exchange generated emails to build their sending reputation. The pool, today's volume, where the mail lands, and the mailboxes that need a look."
        />

        {flag.belowMinimum && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p>
              <strong>Warmup is waiting.</strong> The mailboxes that take part span{' '}
              {overview.participatingDomains === 1 ? '1 domain' : `${overview.participatingDomains} domains`}, and the
              planner needs at least {WARMUP_MIN_POOL_DOMAINS}: it never pairs two mailboxes on the same domain. Add
              mailboxes on {flag.missing === 1 ? 'one more domain' : `${flag.missing} more domains`}.
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="In the network"
            value={number(taking)}
            hint={stalled > 0 ? `${number(stalled)} paused or in error` : 'None paused or in error'}
          />
          <Stat
            label="Domains"
            value={number(overview.participatingDomains)}
            tone={flag.belowMinimum ? 'warning' : 'default'}
            hint={flag.belowMinimum ? `Below the minimum of ${WARMUP_MIN_POOL_DOMAINS}` : `Minimum is ${WARMUP_MIN_POOL_DOMAINS}`}
          />
          <Stat label="Sent today (UTC)" value={number(today.sent)} hint={`${number(today.planned)} planned`} />
          <Stat
            label={`Inbox placement, ${TREND_DAYS} days`}
            value={formatRate(weekRate)}
            tone={weekRate !== null && weekRate < WARMUP_MIN_INBOX_RATE ? 'warning' : 'default'}
            hint={weekRate === null ? 'Nothing judged yet' : `${number(week.inbox + week.spam + week.missing)} emails judged`}
          />
        </div>

        <Section title="Pool by status" note="Removed mailboxes left the pool; their logins are wiped.">
          <ul className="flex flex-wrap gap-3">
            {POOL_STATUSES.map((status) => (
              <li key={status} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <PoolStatusBadge status={status} />
                <span className="text-sm font-medium tabular-nums">{number(overview.byStatus[status])}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Today" note={`UTC day ${today.day}`}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Planned" value={number(today.planned)} />
            <Stat label="Sent" value={number(today.sent)} />
            <Stat label="Engaged" value={number(today.engaged)} hint="Checked in the recipient's mailbox" />
            <Stat label="Failed" value={number(today.failed)} tone={today.failed > 0 ? 'warning' : 'default'} />
          </div>
        </Section>

        <Section
          title="Placement trend"
          note="By day of sending. Pending means sent but not checked in the recipient's mailbox yet."
        >
          <TableFrame
            head={
              <>
                <Th>Day (UTC)</Th>
                <Th right>Sent</Th>
                <Th right>Inbox</Th>
                <Th right>Spam</Th>
                <Th right>Missing</Th>
                <Th right>Pending</Th>
                <Th right>Inbox rate</Th>
              </>
            }
          >
            {[...trend].reverse().map((day) => {
              const sent = day.inbox + day.spam + day.missing + day.pending;
              return (
                <TableRow key={day.day} className="h-10 hover:bg-muted/50">
                  <TableCell className="py-2 tabular-nums">{day.day}</TableCell>
                  <TableCell className="py-2 text-right tabular-nums">{number(sent)}</TableCell>
                  <TableCell className="py-2 text-right tabular-nums">{number(day.inbox)}</TableCell>
                  <TableCell className={cn('py-2 text-right tabular-nums', day.spam > 0 && 'text-amber-600 dark:text-amber-400')}>
                    {number(day.spam)}
                  </TableCell>
                  <TableCell className={cn('py-2 text-right tabular-nums', day.missing > 0 && 'text-amber-600 dark:text-amber-400')}>
                    {number(day.missing)}
                  </TableCell>
                  <TableCell className="py-2 text-right tabular-nums text-muted-foreground">{number(day.pending)}</TableCell>
                  <TableCell className="py-2 text-right">
                    <RateText rate={placementShare(day)} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableFrame>
        </Section>

        <Section
          title="Pool breakdown"
          note={
            flag.belowMinimum
              ? `The pool spans ${overview.participatingDomains} of the ${WARMUP_MIN_POOL_DOMAINS} domains it needs.`
              : `${number(overview.participatingDomains)} domains take part (minimum ${WARMUP_MIN_POOL_DOMAINS}).`
          }
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <GroupTable
              title="By domain"
              keyLabel="Domain"
              rows={overview.byDomain}
              empty="No mailboxes in the pool yet."
              mono
            />
            <div className="space-y-6">
              <GroupTable title="By mailbox type" keyLabel="Type" rows={overview.byType} empty="No mailboxes in the pool yet." />
              <GroupTable
                title="By workspace"
                keyLabel="Workspace"
                rows={overview.byWorkspace}
                empty="No mailboxes in the pool yet."
                href={(row) => `/workspaces/${row.key}`}
              />
            </div>
          </div>
          {(overview.hiddenDomains > 0 || overview.hiddenWorkspaces > 0) && (
            <p className="text-xs text-muted-foreground">
              Showing the biggest groups only
              {overview.hiddenDomains > 0 ? `, ${number(overview.hiddenDomains)} more domains` : ''}
              {overview.hiddenWorkspaces > 0 ? `, ${number(overview.hiddenWorkspaces)} more workspaces` : ''}.
            </p>
          )}
        </Section>

        <Section
          title="Needs attention"
          note="Mailboxes that are paused or in error. A login error pauses the mailbox until someone fixes the login."
        >
          <TableFrame
            head={
              <>
                <Th>Mailbox</Th>
                <Th>Workspace</Th>
                <Th>Status</Th>
                <Th>Reason</Th>
                <Th>Last login error</Th>
                <Th>Changed</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </>
            }
          >
            {problems.length === 0 && <EmptyRow colSpan={7}>Every mailbox in the pool is taking part.</EmptyRow>}
            {problems.map((row) => (
              <TableRow key={row.id} className="h-12 hover:bg-muted/50">
                <TableCell className="py-2 text-sm font-medium">{row.email}</TableCell>
                <TableCell className="py-2 text-xs">
                  <Link href={`/workspaces/${row.workspaceId}`} className="underline-offset-2 hover:underline">
                    {row.workspaceName ?? row.workspaceId}
                  </Link>
                </TableCell>
                <TableCell className="py-2">
                  <PoolStatusBadge status={row.status} />
                </TableCell>
                <TableCell className="py-2 text-xs">{stalledReason(row)}</TableCell>
                <TableCell className="max-w-xs py-2 text-xs">
                  {row.lastLoginError ? (
                    <span title={row.lastLoginError}>{shortenError(row.lastLoginError)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {row.lastLoginErrorAt && (
                    <span className="block text-muted-foreground">{formatDateTime(row.lastLoginErrorAt)}</span>
                  )}
                </TableCell>
                <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">{formatDateTime(row.updatedAt)}</TableCell>
                <TableCell className="py-2 text-right">
                  <MailboxWarmupActions mailbox={row} canWrite={canWrite} />
                </TableCell>
              </TableRow>
            ))}
          </TableFrame>
        </Section>

        <Section
          title="Mailboxes"
          note={
            mailboxes.total > mailboxes.rows.length
              ? `Showing ${number(mailboxes.rows.length)} of ${number(mailboxes.total)}. Search to narrow it down.`
              : `${number(mailboxes.total)} in the pool`
          }
        >
          <form method="get" action="/warmup" className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                name="q"
                aria-label="Search warmup mailboxes"
                defaultValue={q}
                placeholder="Email, domain or workspace…"
                className="h-8 w-72 pl-9"
                maxLength={100}
              />
            </div>
            <Button type="submit" variant="outline" size="sm" className="h-8">
              Search
            </Button>
            {q && (
              <Button asChild variant="ghost" size="sm" className="h-8">
                <Link href="/warmup">Clear</Link>
              </Button>
            )}
          </form>

          <TableFrame
            head={
              <>
                <Th>Mailbox</Th>
                <Th>Workspace</Th>
                <Th>Status</Th>
                <Th right>Ramp day</Th>
                <Th right>Inbox 3d</Th>
                <Th right>Inbox 7d</Th>
                <Th right>Sent 7d</Th>
                <Th right>Spam rescues 7d</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </>
            }
          >
            {mailboxes.rows.length === 0 && (
              <EmptyRow colSpan={9}>{q ? 'No mailboxes match.' : 'No mailboxes in the pool yet.'}</EmptyRow>
            )}
            {mailboxes.rows.map((row) => (
              <TableRow key={row.id} className="h-12 hover:bg-muted/50">
                <TableCell className="py-2">
                  <span className="block text-sm font-medium">{row.email}</span>
                  <span className="block text-xs text-muted-foreground">{row.mailboxType}</span>
                </TableCell>
                <TableCell className="py-2 text-xs">
                  <Link href={`/workspaces/${row.workspaceId}`} className="underline-offset-2 hover:underline">
                    {row.workspaceName ?? row.workspaceId}
                  </Link>
                </TableCell>
                <TableCell className="py-2">
                  <PoolStatusBadge status={row.status} />
                </TableCell>
                <TableCell className="py-2 text-right tabular-nums">{row.rampDay}</TableCell>
                <TableCell className="py-2 text-right">
                  <RateText rate={row.inboxRate3d} />
                </TableCell>
                <TableCell className="py-2 text-right">
                  <RateText rate={row.inboxRate7d} />
                </TableCell>
                <TableCell className="py-2 text-right tabular-nums">{number(row.sent7d)}</TableCell>
                <TableCell className="py-2 text-right tabular-nums">{number(row.spamRescues7d)}</TableCell>
                <TableCell className="py-2 text-right">
                  <MailboxWarmupActions mailbox={row} canWrite={canWrite} />
                </TableCell>
              </TableRow>
            ))}
          </TableFrame>
          {mailboxes.total > MAILBOX_TABLE_LIMIT && !q && (
            <p className="text-xs text-muted-foreground">The table lists the first {MAILBOX_TABLE_LIMIT} mailboxes by address.</p>
          )}
        </Section>
      </PageBody>
    </PageContent>
  );
}
