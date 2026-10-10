'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useMe } from '@/lib/me-context';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { portalPost } from '@/lib/client';
import { formatDate, formatDateTime, formatTime, hourIn } from '@/lib/date';
import type { ClockResult, EmployeeOverview } from '@/lib/types';
import { Card } from '@/components/ui/primitives';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';
import { PayrollReminder } from '@/components/payroll/payroll-reminder';

function greetingKey(timeZone: string): 'employeeGreetingMorning' | 'employeeGreetingAfternoon' | 'employeeGreetingEvening' {
  const hour = hourIn(timeZone);
  if (hour < 12) return 'employeeGreetingMorning';
  if (hour < 18) return 'employeeGreetingAfternoon';
  return 'employeeGreetingEvening';
}

type Overview = EmployeeOverview;

function ClockCard({
  overview,
  canClockIn,
  clocking,
  clockError,
  onClock,
}: Readonly<{
  overview: Overview;
  canClockIn: boolean;
  clocking: boolean;
  clockError: string | null;
  onClock: (action: 'in' | 'out') => void;
}>) {
  const { dict, locale, format, timeZone } = useI18n();
  if (!canClockIn) {
    return (
      <Card>
        <p className="text-sm text-gray-500">{dict.home.clockDisabled}</p>
      </Card>
    );
  }
  const { clockedIn, since } = overview.clock;
  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-sm text-gray-500">
            {clockedIn && since
              ? format(dict.home.clockedInSince, { time: formatTime(since, locale, timeZone) })
              : dict.home.notClockedIn}
          </p>
          {clockError && <p className="text-sm text-red-600 mt-1">{clockError}</p>}
        </div>
        <button
          type="button"
          disabled={clocking}
          onClick={() => onClock(clockedIn ? 'out' : 'in')}
          className={`min-h-[56px] rounded-lg px-8 text-base font-semibold text-white disabled:opacity-50 ${
            clockedIn ? 'bg-red-600 hover:bg-red-700' : 'portal-btn-primary hover:opacity-90'
          }`}
        >
          {clockedIn ? dict.home.clockOut : dict.home.clockIn}
        </button>
      </div>
    </Card>
  );
}

function UpcomingShiftsCard({ overview }: Readonly<{ overview: Overview }>) {
  const { dict, locale, timeZone } = useI18n();
  return (
    <Card>
      <h2 className="font-medium text-gray-900 mb-3">{dict.home.upcomingShifts}</h2>
      {overview.upcomingShifts.length === 0 ? (
        <EmptyState message={dict.home.noShifts} />
      ) : (
        <ul className="space-y-2">
          {overview.upcomingShifts.slice(0, 5).map((shift) => (
            <li key={shift.id} className="flex justify-between text-sm">
              <span className="text-gray-700">{formatDateTime(shift.startsAt, locale, timeZone)}</span>
              <span className="text-gray-500">{shift.companyName}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function LeaveBalancesCard({ overview }: Readonly<{ overview: Overview }>) {
  const { dict } = useI18n();
  return (
    <Card>
      <h2 className="font-medium text-gray-900 mb-3">{dict.home.leaveBalances}</h2>
      {overview.leaveBalances.length === 0 ? (
        <EmptyState message={dict.leave.empty} />
      ) : (
        <ul className="space-y-2">
          {overview.leaveBalances.map((b) => (
            <li key={b.leaveTypeId} className="flex justify-between text-sm">
              <span className="text-gray-700">{b.name}</span>
              <span className="text-gray-500">{b.remaining ?? dict.leave.unlimited}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AcknowledgeLink({
  href,
  count,
  singular,
  plural,
}: Readonly<{
  href: string;
  count: number;
  singular: string;
  plural: string;
}>) {
  const { format } = useI18n();
  return (
    <li>
      <Link href={href} className="portal-link underline underline-offset-2">
        {format(count === 1 ? singular : plural, { count })}
      </Link>
    </li>
  );
}

function AcknowledgeCard({ overview, slug }: Readonly<{ overview: Overview; slug: string }>) {
  const { dict } = useI18n();
  const { coaching, evaluations } = overview.toAcknowledge;
  return (
    <Card>
      <h2 className="font-medium text-gray-900 mb-3">{dict.home.toAcknowledge}</h2>
      {coaching === 0 && evaluations === 0 ? (
        <EmptyState message={dict.home.allCaughtUp} />
      ) : (
        <ul className="space-y-2 text-sm">
          {coaching > 0 && (
            <AcknowledgeLink
              href={`/${slug}/me/coaching`}
              count={coaching}
              singular={dict.home.coachingSessions}
              plural={dict.home.coachingSessionsPlural}
            />
          )}
          {evaluations > 0 && (
            <AcknowledgeLink
              href={`/${slug}/me/evaluations`}
              count={evaluations}
              singular={dict.home.evaluationsToAck}
              plural={dict.home.evaluationsToAckPlural}
            />
          )}
        </ul>
      )}
    </Card>
  );
}

function OpenTasksCard({ overview, slug }: Readonly<{ overview: Overview; slug: string }>) {
  const { dict } = useI18n();
  return (
    <Card>
      <h2 className="font-medium text-gray-900 mb-3">{dict.home.openTasks}</h2>
      {overview.openTasks === 0 ? (
        <EmptyState message={dict.home.noOpenTasks} />
      ) : (
        <Link href={`/${slug}/me/tasks`} className="portal-link underline underline-offset-2 text-sm">
          {overview.openTasks}
        </Link>
      )}
    </Card>
  );
}

function LatestEvaluationCard({ overview }: Readonly<{ overview: Overview }>) {
  const { dict, locale, timeZone } = useI18n();
  const evaluation = overview.latestEvaluation;
  return (
    <Card>
      <h2 className="font-medium text-gray-900 mb-3">{dict.home.latestEvaluation}</h2>
      {!evaluation ? (
        <EmptyState message={dict.home.noEvaluationYet} />
      ) : (
        <div className="text-sm space-y-1">
          <p className="text-gray-700">{evaluation.formName || dict.evaluations.title}</p>
          <p className="text-gray-500">
            {evaluation.overallScore ?? dict.common.none} · {formatDate(evaluation.submittedAt, locale, timeZone)}
          </p>
        </div>
      )}
    </Card>
  );
}

function ManagerCard({ overview }: Readonly<{ overview: Overview }>) {
  const { dict } = useI18n();
  const { manager, clients } = overview.profile;
  return (
    <Card>
      <h2 className="font-medium text-gray-900 mb-3">{dict.home.manager}</h2>
      {!manager ? (
        <EmptyState message={dict.home.noManager} />
      ) : (
        <p className="text-sm text-gray-700">{manager.displayName}</p>
      )}
      <h2 className="font-medium text-gray-900 mt-4 mb-2">{dict.home.clientAccounts}</h2>
      {clients.length === 0 ? (
        <EmptyState message={dict.home.noClients} />
      ) : (
        <ul className="text-sm text-gray-700 space-y-1">
          {clients.map((c) => (
            <li key={c.companyId}>{c.companyName}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function EmployeeHomeView() {
  const slug = String(useParams().workspace ?? '');
  const me = useMe();
  const { dict, format, timeZone } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<EmployeeOverview>(slug, '/employee/overview');
  const [clocking, setClocking] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);

  async function clock(action: 'in' | 'out') {
    setClocking(true);
    setClockError(null);
    try {
      await portalPost<ClockResult>(slug, '/employee/clock', { action });
      refetch();
    } catch (err) {
      setClockError(err instanceof Error ? err.message : dict.errors.generic);
    } finally {
      setClocking(false);
    }
  }

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  const firstName = data.profile.firstName || data.profile.displayName;
  const greeting = format(dict.home[greetingKey(timeZone)], { name: firstName });
  const canClockIn = me.kind === 'employee' && me.config.features.selfClockIn;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">{greeting}</h1>
      </div>

      <PayrollReminder />

      <ClockCard
        overview={data}
        canClockIn={canClockIn}
        clocking={clocking}
        clockError={clockError}
        onClock={(action) => void clock(action)}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <UpcomingShiftsCard overview={data} />
        <LeaveBalancesCard overview={data} />
        <AcknowledgeCard overview={data} slug={slug} />
        <OpenTasksCard overview={data} slug={slug} />
        <LatestEvaluationCard overview={data} />
        <ManagerCard overview={data} />
      </div>
    </div>
  );
}
