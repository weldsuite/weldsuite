'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useMe } from '@/lib/me-context';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { portalPost } from '@/lib/client';
import { formatDate, formatDateTime, formatTime } from '@/lib/date';
import type { ClockResult, EmployeeOverview } from '@/lib/types';
import { Card } from '@/components/ui/primitives';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

function greetingKey(): 'employeeGreetingMorning' | 'employeeGreetingAfternoon' | 'employeeGreetingEvening' {
  const hour = new Date().getHours();
  if (hour < 12) return 'employeeGreetingMorning';
  if (hour < 18) return 'employeeGreetingAfternoon';
  return 'employeeGreetingEvening';
}

export default function EmployeeHomePage() {
  const slug = String(useParams().workspace ?? '');
  const me = useMe();
  const { dict, locale, format } = useI18n();
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
  const greeting = format(dict.home[greetingKey()], { name: firstName });
  const canClockIn = me.kind === 'employee' && me.config.features.selfClockIn;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">{greeting}</h1>
      </div>

      <Card>
        {canClockIn ? (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <p className="text-sm text-gray-500">
                {data.clock.clockedIn && data.clock.since
                  ? format(dict.home.clockedInSince, { time: formatTime(data.clock.since, locale) })
                  : dict.home.notClockedIn}
              </p>
              {clockError && <p className="text-sm text-red-600 mt-1">{clockError}</p>}
            </div>
            <button
              type="button"
              disabled={clocking}
              onClick={() => void clock(data.clock.clockedIn ? 'out' : 'in')}
              className={`min-h-[56px] rounded-lg px-8 text-base font-semibold text-white disabled:opacity-50 ${
                data.clock.clockedIn ? 'bg-red-600 hover:bg-red-700' : 'portal-btn-primary hover:opacity-90'
              }`}
            >
              {data.clock.clockedIn ? dict.home.clockOut : dict.home.clockIn}
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-500">{dict.home.clockDisabled}</p>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <h2 className="font-medium text-gray-900 mb-3">{dict.home.upcomingShifts}</h2>
          {data.upcomingShifts.length === 0 ? (
            <EmptyState message={dict.home.noShifts} />
          ) : (
            <ul className="space-y-2">
              {data.upcomingShifts.slice(0, 5).map((shift) => (
                <li key={shift.id} className="flex justify-between text-sm">
                  <span className="text-gray-700">{formatDateTime(shift.startsAt, locale)}</span>
                  <span className="text-gray-500">{shift.companyName}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="font-medium text-gray-900 mb-3">{dict.home.leaveBalances}</h2>
          {data.leaveBalances.length === 0 ? (
            <EmptyState message={dict.leave.empty} />
          ) : (
            <ul className="space-y-2">
              {data.leaveBalances.map((b) => (
                <li key={b.leaveTypeId} className="flex justify-between text-sm">
                  <span className="text-gray-700">{b.name}</span>
                  <span className="text-gray-500">{b.remaining === null ? dict.leave.unlimited : b.remaining}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="font-medium text-gray-900 mb-3">{dict.home.toAcknowledge}</h2>
          {data.toAcknowledge.coaching === 0 && data.toAcknowledge.evaluations === 0 ? (
            <EmptyState message={dict.home.allCaughtUp} />
          ) : (
            <ul className="space-y-2 text-sm">
              {data.toAcknowledge.coaching > 0 && (
                <li>
                  <Link href={`/${slug}/me/coaching`} className="portal-link underline underline-offset-2">
                    {format(
                      data.toAcknowledge.coaching === 1 ? dict.home.coachingSessions : dict.home.coachingSessionsPlural,
                      { count: data.toAcknowledge.coaching },
                    )}
                  </Link>
                </li>
              )}
              {data.toAcknowledge.evaluations > 0 && (
                <li>
                  <Link href={`/${slug}/me/evaluations`} className="portal-link underline underline-offset-2">
                    {format(
                      data.toAcknowledge.evaluations === 1 ? dict.home.evaluationsToAck : dict.home.evaluationsToAckPlural,
                      { count: data.toAcknowledge.evaluations },
                    )}
                  </Link>
                </li>
              )}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="font-medium text-gray-900 mb-3">{dict.home.openTasks}</h2>
          {data.openTasks === 0 ? (
            <EmptyState message={dict.home.noOpenTasks} />
          ) : (
            <Link href={`/${slug}/me/tasks`} className="portal-link underline underline-offset-2 text-sm">
              {data.openTasks}
            </Link>
          )}
        </Card>

        <Card>
          <h2 className="font-medium text-gray-900 mb-3">{dict.home.latestEvaluation}</h2>
          {!data.latestEvaluation ? (
            <EmptyState message={dict.home.noEvaluationYet} />
          ) : (
            <div className="text-sm space-y-1">
              <p className="text-gray-700">{data.latestEvaluation.formName || dict.evaluations.title}</p>
              <p className="text-gray-500">
                {data.latestEvaluation.overallScore ?? dict.common.none} · {formatDate(data.latestEvaluation.submittedAt, locale)}
              </p>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="font-medium text-gray-900 mb-3">{dict.home.manager}</h2>
          {!data.profile.manager ? (
            <EmptyState message={dict.home.noManager} />
          ) : (
            <p className="text-sm text-gray-700">{data.profile.manager.displayName}</p>
          )}
          <h2 className="font-medium text-gray-900 mt-4 mb-2">{dict.home.clientAccounts}</h2>
          {data.profile.clients.length === 0 ? (
            <EmptyState message={dict.home.noClients} />
          ) : (
            <ul className="text-sm text-gray-700 space-y-1">
              {data.profile.clients.map((c) => (
                <li key={c.companyId}>{c.companyName}</li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
