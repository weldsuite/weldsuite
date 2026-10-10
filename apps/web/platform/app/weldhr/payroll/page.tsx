/**
 * WeldHR Payroll home: what is left to set up, the next period of each pay
 * schedule (start or open its run), the latest runs and the filings that are
 * due. Employes' flow is the model: set up once, then each month open the run
 * and approve it.
 */

import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { CalendarClock, Check, Circle, FileText, Loader2, Settings, Users, UserX } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrPayrollOverview } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { PageLoader } from '@/components/page-loader';
import { useCreateHrPayRun, useHrPayrollOverview } from '@/hooks/queries/use-weldhr-payroll-queries';
import { DashboardPage, EmptyText, KpiCard, KpiGrid, SectionCard, useHrBreadcrumbs } from '../components/page-kit';
import { ErrorBanner, errorMessage, formatDate } from '../components/shared';
import { FilingStatusBadge, IssueList, PayrollGate, RunStatusBadge } from './components/payroll-ui';
import { countryCurrency, formatCents, formatDecimal, periodRange } from './lib/format';

export default function WeldHrPayrollHomePage() {
  return (
    <PayrollGate>
      <PayrollHome />
    </PayrollGate>
  );
}

function PayrollHome() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.payroll.title') });
  const { can } = usePermissions();
  const { data, isLoading, error } = useHrPayrollOverview();

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <DashboardPage
      title={t('weldhr.payroll.title')}
      actions={
        can('payroll:manage') && (
          <Button asChild variant="outline" size="sm">
            <Link to="/weldhr/payroll/settings">
              <Settings className="mr-1.5 h-4 w-4" />
              {t('weldhr.payroll.home.settingsLink')}
            </Link>
          </Button>
        )
      }
    >
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.payroll.home.loadFailed')) : null} />
      {data && <HomeBody overview={data} />}
    </DashboardPage>
  );
}

function HomeBody({ overview }: Readonly<{ overview: HrPayrollOverview }>) {
  const t = useTranslations();
  const { setup } = overview;
  const openRuns = overview.recentRuns.filter((run) => run.status === 'draft' || run.status === 'calculated' || run.status === 'approved').length;
  const employerIssues = overview.employers.filter((employer) => employer.issues.length > 0);
  const setupComplete = setup.hasEmployer && setup.hasSchedule && setup.employeesOnPayroll > 0 && setup.employeesNotReady === 0;

  return (
    <>
      <KpiGrid>
        <KpiCard label={t('weldhr.payroll.home.kpis.onPayroll')} value={setup.employeesOnPayroll} icon={Users} />
        <KpiCard
          label={t('weldhr.payroll.home.kpis.notReady')}
          value={setup.employeesNotReady}
          icon={UserX}
          tone={setup.employeesNotReady > 0 ? 'warning' : 'default'}
        />
        <KpiCard label={t('weldhr.payroll.home.kpis.openRuns')} value={openRuns} icon={CalendarClock} />
        <KpiCard
          label={t('weldhr.payroll.home.kpis.filingsDue')}
          value={overview.filingsDue.length}
          icon={FileText}
          tone={overview.filingsDue.length > 0 ? 'warning' : 'default'}
        />
      </KpiGrid>

      {!setupComplete && <SetupChecklist overview={overview} />}

      {employerIssues.length > 0 && (
        <SectionCard title={t('weldhr.payroll.home.employerIssues')}>
          <div className="space-y-4">
            {employerIssues.map((employer) => (
              <div key={employer.id} className="space-y-2">
                <p className="text-sm font-medium">{employer.name}</p>
                <IssueList issues={employer.issues} currency={countryCurrency(employer.country)} />
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <UpcomingCard upcoming={overview.upcoming} />
        <FilingsDueCard filings={overview.filingsDue} />
      </div>

      <RecentRunsCard runs={overview.recentRuns} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Setup checklist
// ---------------------------------------------------------------------------

function SetupChecklist({ overview }: Readonly<{ overview: HrPayrollOverview }>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const { setup } = overview;
  const canManage = can('payroll:manage');

  const steps: Array<{ id: string; done: boolean; title: string; description: string; cta?: { label: string; to: '/weldhr/payroll/settings' | '/weldhr/payroll/employees' } }> = [
    {
      id: 'employer',
      done: setup.hasEmployer,
      title: t('weldhr.payroll.home.setup.employer.title'),
      description: t('weldhr.payroll.home.setup.employer.description'),
      cta: canManage ? { label: t('weldhr.payroll.home.setup.employer.cta'), to: '/weldhr/payroll/settings' } : undefined,
    },
    {
      id: 'schedule',
      done: setup.hasSchedule,
      title: t('weldhr.payroll.home.setup.schedule.title'),
      description: t('weldhr.payroll.home.setup.schedule.description'),
      cta: canManage && setup.hasEmployer ? { label: t('weldhr.payroll.home.setup.schedule.cta'), to: '/weldhr/payroll/settings' } : undefined,
    },
    {
      id: 'employees',
      done: setup.employeesOnPayroll > 0,
      title: t('weldhr.payroll.home.setup.employees.title'),
      description: t('weldhr.payroll.home.setup.employees.description'),
      cta: { label: t('weldhr.payroll.home.setup.employees.cta'), to: '/weldhr/payroll/employees' },
    },
    {
      id: 'ready',
      done: setup.employeesOnPayroll > 0 && setup.employeesNotReady === 0,
      title: t('weldhr.payroll.home.setup.ready.title'),
      description:
        setup.employeesNotReady > 0
          ? t('weldhr.payroll.home.setup.ready.descriptionCount', { count: setup.employeesNotReady })
          : t('weldhr.payroll.home.setup.ready.description'),
      cta: setup.employeesOnPayroll > 0 ? { label: t('weldhr.payroll.home.setup.ready.cta'), to: '/weldhr/payroll/employees' } : undefined,
    },
  ];

  return (
    <SectionCard title={t('weldhr.payroll.home.setup.title')}>
      <ol className="divide-y">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            {step.done ? (
              <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{step.title}</p>
              <p className="text-sm text-muted-foreground">{step.description}</p>
            </div>
            {!step.done && step.cta && (
              <Button asChild size="sm" variant="outline">
                <Link to={step.cta.to}>{step.cta.label}</Link>
              </Button>
            )}
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Upcoming periods
// ---------------------------------------------------------------------------

function UpcomingCard({ upcoming }: Readonly<{ upcoming: HrPayrollOverview['upcoming'] }>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const createRun = useCreateHrPayRun();
  const canPrepare = can('payroll:prepare');

  async function start(item: HrPayrollOverview['upcoming'][number]) {
    try {
      const run = await createRun.mutateAsync({
        employerId: item.employerId,
        kind: 'regular',
        payScheduleId: item.scheduleId,
        periodStart: item.period.start,
      });
      void navigate({ to: '/weldhr/payroll/runs/$runId', params: { runId: run.data.id } });
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.payroll.runs.startFailed')));
    }
  }

  return (
    <SectionCard title={t('weldhr.payroll.home.upcoming.title')} contentClassName="p-0">
      {upcoming.length === 0 ? (
        <EmptyText>{t('weldhr.payroll.home.upcoming.empty')}</EmptyText>
      ) : (
        <ul className="divide-y">
          {upcoming.map((item) => (
            <li key={item.scheduleId} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {item.scheduleName} <span className="font-normal text-muted-foreground">· {item.employerName}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {periodRange(item.period.start, item.period.end)} · {t('weldhr.payroll.home.upcoming.payDate', { date: formatDate(item.period.payDate) })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {item.runStatus && <RunStatusBadge status={item.runStatus} />}
                {item.runId ? (
                  <Button asChild size="sm" variant="outline">
                    <Link to="/weldhr/payroll/runs/$runId" params={{ runId: item.runId }}>
                      {t('weldhr.payroll.home.upcoming.open')}
                    </Link>
                  </Button>
                ) : (
                  canPrepare && (
                    <Button size="sm" onClick={() => void start(item)} disabled={createRun.isPending}>
                      {createRun.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                      {t('weldhr.payroll.home.upcoming.start')}
                    </Button>
                  )
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Filings due
// ---------------------------------------------------------------------------

function FilingsDueCard({ filings }: Readonly<{ filings: HrPayrollOverview['filingsDue'] }>) {
  const t = useTranslations();
  return (
    <SectionCard
      title={t('weldhr.payroll.home.filingsDue.title')}
      contentClassName="p-0"
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/weldhr/payroll/filings">{t('weldhr.payroll.home.viewAll')}</Link>
        </Button>
      }
    >
      {filings.length === 0 ? (
        <EmptyText>{t('weldhr.payroll.home.filingsDue.empty')}</EmptyText>
      ) : (
        <ul className="divide-y">
          {filings.map((filing) => (
            <li key={filing.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {t(`weldhr.payroll.filingKind.${filing.kind}`)}
                  <span className="font-normal text-muted-foreground"> · {filing.employerName}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {periodRange(filing.periodStart, filing.periodEnd)}
                  {filing.dueDate && ` · ${t('weldhr.payroll.home.filingsDue.due', { date: formatDate(filing.dueDate) })}`}
                </p>
                {filing.paymentReference && (
                  <p className="text-xs text-muted-foreground">
                    {t('weldhr.payroll.filings.paymentReference')}: <span className="font-mono">{filing.paymentReference}</span>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium tabular-nums">{formatDecimal(filing.amountDue, countryCurrency(filing.country))}</span>
                <FilingStatusBadge status={filing.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Recent runs
// ---------------------------------------------------------------------------

function RecentRunsCard({ runs }: Readonly<{ runs: HrPayrollOverview['recentRuns'] }>) {
  const t = useTranslations();
  return (
    <SectionCard
      title={t('weldhr.payroll.home.recentRuns.title')}
      contentClassName="p-0"
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/weldhr/payroll/runs">{t('weldhr.payroll.home.viewAll')}</Link>
        </Button>
      }
    >
      {runs.length === 0 ? (
        <EmptyText>{t('weldhr.payroll.home.recentRuns.empty')}</EmptyText>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('weldhr.payroll.common.period')}</TableHead>
              <TableHead>{t('weldhr.payroll.common.employer')}</TableHead>
              <TableHead>{t('weldhr.payroll.common.employees')}</TableHead>
              <TableHead className="text-right">{t('weldhr.payroll.common.net')}</TableHead>
              <TableHead>{t('weldhr.payroll.common.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <Link to="/weldhr/payroll/runs/$runId" params={{ runId: run.id }} className="font-medium hover:underline">
                    {periodRange(run.periodStart, run.periodEnd)}
                  </Link>
                  {run.kind !== 'regular' && <span className="ml-2 text-xs text-muted-foreground">{t(`weldhr.payroll.runKind.${run.kind}`)}</span>}
                </TableCell>
                <TableCell>{run.employerName}</TableCell>
                <TableCell className="tabular-nums">{run.employeeCount}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(run.totals?.netCents, run.currency)}</TableCell>
                <TableCell>
                  <RunStatusBadge status={run.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
