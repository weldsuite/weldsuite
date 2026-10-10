/** My HR → Overview: clock in/out, what needs attention, leave balances, upcoming shifts and the profile. */

import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ClipboardList, Loader2, LogIn, LogOut, MessageSquareHeart, Star, Target } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfOverview, HrSelfProfile } from '@weldsuite/app-api-client/domains/weldhr';
import { useMyHrClock, useMyHrOverview } from '@/hooks/queries/use-weldhr-queries';
import { MY_HR_PATHS, type MyHrPath } from '../../access';
import { EmptyText, FieldGrid, KpiCard, KpiGrid, SectionCard } from '../../components/page-kit';
import { ErrorBanner, errorMessage, formatDate, formatDateTime, formatTime } from '../../components/shared';
import { LeaveBalanceTiles } from './leave-balances';
import { TabLoading } from './shared';
import { UpcomingShiftsCard } from './shifts-card';

/** Today's clock-ins read as a time, older ones as a date and time. */
function formatSince(since: string): string {
  return new Date(since).toDateString() === new Date().toDateString() ? formatTime(since) : formatDateTime(since);
}

export function MyOverviewTab({
  employee,
  canClockIn,
}: Readonly<{
  employee: HrSelfProfile;
  canClockIn: boolean;
}>) {
  const t = useTranslations();
  const navigate = useNavigate();
  const { data: overview, isLoading, error } = useMyHrOverview();

  if (isLoading) return <TabLoading />;
  if (!overview) return <ErrorBanner error={errorMessage(error, t('weldhr.me.overview.loadFailed'))} />;

  const toAcknowledge = overview.toAcknowledge.coaching + overview.toAcknowledge.evaluations;
  const totalMilestones = overview.milestones.achieved + overview.milestones.open;
  const latest = overview.latestEvaluation;
  const latestScore = latest?.overallScore;

  return (
    <div className="space-y-4">
      {canClockIn && <ClockCard clock={overview.clock} />}

      <KpiGrid>
        <KpiLink to={MY_HR_PATHS.tasks}>
          <KpiCard
            label={t('weldhr.me.overview.kpis.openTasks')}
            value={overview.openTasks}
            icon={ClipboardList}
            tone={overview.openTasks > 0 ? 'warning' : 'default'}
          />
        </KpiLink>
        <KpiLink to={MY_HR_PATHS.reviews}>
          <KpiCard
            label={t('weldhr.me.overview.kpis.toAcknowledge')}
            value={toAcknowledge}
            icon={MessageSquareHeart}
            tone={toAcknowledge > 0 ? 'warning' : 'default'}
            hint={t('weldhr.me.overview.kpis.toAcknowledgeHint', {
              coaching: overview.toAcknowledge.coaching,
              evaluations: overview.toAcknowledge.evaluations,
            })}
          />
        </KpiLink>
        <KpiLink to={MY_HR_PATHS.reviews}>
          <KpiCard
            label={t('weldhr.me.overview.kpis.latestEvaluation')}
            value={latestScore === null || latestScore === undefined ? '—' : latestScore.toFixed(1)}
            icon={Star}
            hint={
              latest
                ? [latest.formName, latest.submittedAt ? formatDate(latest.submittedAt) : null].filter(Boolean).join(' · ')
                : t('weldhr.me.overview.kpis.noEvaluation')
            }
          />
        </KpiLink>
        <KpiLink to={MY_HR_PATHS.reviews}>
          <KpiCard
            label={t('weldhr.me.overview.kpis.milestones')}
            value={`${overview.milestones.achieved}/${totalMilestones}`}
            icon={Target}
            hint={t('weldhr.me.overview.kpis.milestonesHint', { open: overview.milestones.open })}
          />
        </KpiLink>
      </KpiGrid>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={t('weldhr.me.overview.leaveBalances')}
          action={
            <Link to={MY_HR_PATHS.timeOff}>
              <Button variant="ghost" size="sm">
                {t('weldhr.me.common.viewAll')}
              </Button>
            </Link>
          }
        >
          <LeaveBalanceTiles balances={overview.leaveBalances} />
        </SectionCard>

        <UpcomingShiftsCard shifts={overview.upcomingShifts} limit={5} onViewAll={() => void navigate({ to: MY_HR_PATHS.schedule })} />

        <SectionCard title={t('weldhr.me.overview.profile.title')}>
          <FieldGrid
            fields={[
              { label: t('weldhr.me.overview.profile.email'), value: employee.email },
              { label: t('weldhr.me.overview.profile.phone'), value: employee.phone },
              { label: t('weldhr.me.overview.profile.employeeNumber'), value: employee.employeeNumber },
              { label: t('weldhr.me.overview.profile.employmentType'), value: t(`weldhr.status.employmentType.${employee.employmentType}`) },
              { label: t('weldhr.me.overview.profile.startDate'), value: formatDate(employee.startDate) },
              { label: t('weldhr.me.overview.profile.location'), value: employee.location },
            ]}
          />
        </SectionCard>

        <SectionCard title={t('weldhr.me.overview.clients.title')}>
          {employee.clients.length === 0 ? (
            <EmptyText>{t('weldhr.me.overview.clients.empty')}</EmptyText>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {employee.clients.map((client) => (
                <Badge key={client.companyId} variant={client.isPrimary ? 'default' : 'secondary'}>
                  {client.companyName ?? client.companyId}
                </Badge>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

/** Makes a KPI card a link to the My HR page behind it. */
function KpiLink({ to, children }: Readonly<{ to: MyHrPath; children: ReactNode }>) {
  return (
    <Link
      to={to}
      className="block w-full rounded-lg text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </Link>
  );
}

function ClockCard({ clock }: Readonly<{ clock: HrSelfOverview['clock'] }>) {
  const t = useTranslations();
  const clockMutation = useMyHrClock();
  const [failure, setFailure] = useState<string | null>(null);

  async function toggle() {
    const action = clock.clockedIn ? 'out' : 'in';
    setFailure(null);
    try {
      await clockMutation.mutateAsync({ action });
      toast.success(t(action === 'in' ? 'weldhr.me.overview.clock.clockedInToast' : 'weldhr.me.overview.clock.clockedOutToast'));
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.me.overview.clock.failed')));
    }
  }

  let icon = <LogIn className="mr-2 h-4 w-4" />;
  if (clockMutation.isPending) icon = <Loader2 className="mr-2 h-4 w-4 animate-spin" />;
  else if (clock.clockedIn) icon = <LogOut className="mr-2 h-4 w-4" />;

  return (
    <SectionCard title={t('weldhr.me.overview.clock.title')}>
      <div className="space-y-3">
        <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            {clock.clockedIn && clock.since
              ? t('weldhr.me.overview.clock.clockedInSince', { time: formatSince(clock.since) })
              : t('weldhr.me.overview.clock.notClockedIn')}
          </p>
          <Button
            variant={clock.clockedIn ? 'destructive' : 'default'}
            onClick={() => void toggle()}
            disabled={clockMutation.isPending}
          >
            {icon}
            {clock.clockedIn ? t('weldhr.me.overview.clock.clockOut') : t('weldhr.me.overview.clock.clockIn')}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
