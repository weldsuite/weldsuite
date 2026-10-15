import Link from 'next/link';
import { MailWarning } from 'lucide-react';
import { TableCell, TableRow } from '@weldsuite/ui/components/table';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { CaseCard } from '@/components/outbound-mail/case-card';
import { PlatformStatusCard } from '@/components/outbound-mail/live';
import { FilterTabs, RiskScore, StateBadge, TrustText } from '@/components/outbound-mail/parts';
import { EmptyRow, Section, TableFrame, Th } from '@/components/warmup/parts';
import { requireAdmin } from '@/lib/auth';
import { formatDate } from '@/app/workspaces/workspace-presentation';
import { formatDateTime } from '@/lib/billing-format';
import { loadPlatformStatus } from '@/lib/mail-api';
import {
  CASE_STATUS_LABELS,
  OUTBOUND_CASE_SEVERITIES,
  OUTBOUND_CASE_STATUSES,
  OUTBOUND_CASE_TRIGGERS,
  OUTBOUND_STATES,
  SEVERITY_LABELS,
  STATE_LABELS,
  TRIGGER_LABELS,
  actorLabel,
  outboundHref,
  readFilters,
} from '@/lib/outbound-mail';
import {
  CASE_LIST_LIMIT,
  WORKSPACE_TABLE_LIMIT,
  countCasesByStatus,
  countPoliciesByState,
  getCase,
  listCases,
  listPlatformEvents,
  listRiskWorkspaces,
} from '@/lib/outbound-mail-data';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function OutboundMailPage(props: Readonly<{ searchParams?: Promise<SearchParams> }>) {
  const identity = await requireAdmin();
  const filters = readFilters((await props.searchParams) ?? {});
  const canWrite = identity.role !== 'viewer';

  const [platform, platformEvents, workspaces, stateCounts, cases, caseCounts, linked] = await Promise.all([
    loadPlatformStatus(identity),
    listPlatformEvents(1),
    listRiskWorkspaces(filters.state),
    countPoliciesByState(),
    listCases(filters),
    countCasesByStatus(),
    filters.caseId ? getCase(filters.caseId) : Promise.resolve(null),
  ]);

  const stateTotal = OUTBOUND_STATES.reduce((sum, state) => sum + stateCounts[state], 0);
  const caseTotal = OUTBOUND_CASE_STATUSES.reduce((sum, status) => sum + caseCounts[status], 0);
  // The linked case shows on its own at the top; don't repeat it in the list.
  const listed = linked ? cases.filter((row) => row.id !== linked.id) : cases;

  return (
    <PageContent>
      <PageBody className="space-y-8">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <MailWarning className="h-6 w-6 text-primary" />
              Outbound mail
            </span>
          }
          description="Every email a customer writes leaves through WeldSuite's one Cloudflare account. The guard limits and screens those sends: the platform breaker, workspaces by risk, and the cases it opened for review."
        />

        {filters.caseId && (
          <Section title="Linked case" note="Opened from a link, such as an alert email">
            {linked ? (
              <CaseCard row={linked} canWrite={canWrite} highlighted />
            ) : (
              <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                Case {filters.caseId} was not found.
              </p>
            )}
          </Section>
        )}

        <Section title="Platform" note="Live from mail-api">
          <PlatformStatusCard state={platform} events={platformEvents} />
        </Section>

        <Section
          title="Workspaces by risk"
          note={
            workspaces.total > workspaces.rows.length
              ? `Showing the ${WORKSPACE_TABLE_LIMIT} riskiest of ${workspaces.total.toLocaleString('en-GB')}.`
              : 'Workspaces with a policy: a risk score, a restriction or staff settings. The rest send on the defaults.'
          }
        >
          <FilterTabs
            label="State"
            selected={filters.state}
            tabs={[
              { key: 'all', label: 'All', count: stateTotal, href: outboundHref(filters, { state: 'all', caseId: null }) },
              ...OUTBOUND_STATES.map((state) => ({
                key: state,
                label: STATE_LABELS[state],
                count: stateCounts[state],
                href: outboundHref(filters, { state, caseId: null }),
              })),
            ]}
          />
          <TableFrame
            head={
              <>
                <Th>Workspace</Th>
                <Th>Plan</Th>
                <Th>Created</Th>
                <Th>Trust</Th>
                <Th>State</Th>
                <Th right>Risk</Th>
                <Th>Updated</Th>
                <Th right>Open cases</Th>
              </>
            }
          >
            {workspaces.rows.length === 0 && (
              <EmptyRow colSpan={8}>
                {filters.state === 'all' ? 'No workspace has a policy yet.' : `No workspace is ${STATE_LABELS[filters.state].toLowerCase()}.`}
              </EmptyRow>
            )}
            {workspaces.rows.map((row) => (
              <TableRow key={row.workspaceId} className="h-12 hover:bg-muted/50">
                <TableCell className="py-2">
                  <Link href={`/outbound-mail/${row.workspaceId}`} className="block min-w-0">
                    <span className="block truncate text-sm font-medium underline-offset-2 hover:underline">
                      {row.name ?? row.workspaceId}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {row.deleted ? 'deleted' : row.slug}
                    </span>
                  </Link>
                </TableCell>
                <TableCell className="py-2 text-xs">{row.planName ?? 'no plan'}</TableCell>
                <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">
                  {row.createdAt ? formatDate(row.createdAt, false) : '—'}
                </TableCell>
                <TableCell className="py-2">
                  <TrustText trust={row.trust} />
                </TableCell>
                <TableCell className="py-2">
                  <span className="flex flex-col items-start gap-0.5">
                    <StateBadge state={row.state} />
                    {row.state !== 'active' && row.stateSetBy && (
                      <span className="text-[11px] text-muted-foreground">by {actorLabel(row.stateSetBy)}</span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="py-2 text-right">
                  <RiskScore score={row.riskScore} />
                </TableCell>
                <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">
                  {formatDateTime(row.riskUpdatedAt ?? row.updatedAt)}
                </TableCell>
                <TableCell className="py-2 text-right tabular-nums">
                  {row.openCases > 0 ? (
                    <span className="font-medium text-amber-600 dark:text-amber-400">{row.openCases}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableFrame>
        </Section>

        <Section
          title="Cases"
          note={
            listed.length >= CASE_LIST_LIMIT
              ? `Showing the newest ${CASE_LIST_LIMIT}. Filter to narrow it down.`
              : 'Newest first. Confirm or dismiss each one: the reviews are the test set for tuning.'
          }
        >
          <div className="space-y-2">
            <FilterTabs
              label="Status"
              selected={filters.status}
              tabs={[
                ...OUTBOUND_CASE_STATUSES.map((status) => ({
                  key: status,
                  label: CASE_STATUS_LABELS[status],
                  count: caseCounts[status],
                  href: outboundHref(filters, { status, caseId: null }),
                })),
                { key: 'all', label: 'All', count: caseTotal, href: outboundHref(filters, { status: 'all', caseId: null }) },
              ]}
            />
            <FilterTabs
              label="Severity"
              selected={filters.severity}
              tabs={[
                { key: 'all', label: 'All', href: outboundHref(filters, { severity: 'all', caseId: null }) },
                ...OUTBOUND_CASE_SEVERITIES.map((severity) => ({
                  key: severity,
                  label: SEVERITY_LABELS[severity],
                  href: outboundHref(filters, { severity, caseId: null }),
                })),
              ]}
            />
            <FilterTabs
              label="Trigger"
              selected={filters.trigger}
              tabs={[
                { key: 'all', label: 'All', href: outboundHref(filters, { trigger: 'all', caseId: null }) },
                ...OUTBOUND_CASE_TRIGGERS.map((trigger) => ({
                  key: trigger,
                  label: TRIGGER_LABELS[trigger],
                  href: outboundHref(filters, { trigger, caseId: null }),
                })),
              ]}
            />
          </div>

          {listed.length === 0 ? (
            <p className="rounded-lg border py-10 text-center text-sm text-muted-foreground">
              {filters.status === 'open' && filters.trigger === 'all' && filters.severity === 'all'
                ? 'No open cases.'
                : 'No cases match.'}
            </p>
          ) : (
            <div className="space-y-3">
              {listed.map((row) => (
                <CaseCard key={row.id} row={row} canWrite={canWrite} />
              ))}
            </div>
          )}
        </Section>
      </PageBody>
    </PageContent>
  );
}
