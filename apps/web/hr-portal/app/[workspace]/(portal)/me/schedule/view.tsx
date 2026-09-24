'use client';

import { useParams } from 'next/navigation';
import { useDeferredValue, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { formatDate, formatDateTime } from '@/lib/date';
import { defaultScheduleRange } from '@/lib/schedule-range';
import type { EmployeeAttendance } from '@/lib/types';
import { Card, Input, Label, PageHeader } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

export default function ScheduleView() {
  const slug = String(useParams().workspace ?? '');
  const { dict, locale, format, timeZone } = useI18n();
  const [from, setFrom] = useState(() => defaultScheduleRange().from);
  const [to, setTo] = useState(() => defaultScheduleRange().to);
  const deferredFrom = useDeferredValue(from);
  const deferredTo = useDeferredValue(to);
  const { data, loading, error, refetch } = usePortalQuery<EmployeeAttendance>(slug, '/employee/attendance', {
    query: { from: deferredFrom, to: deferredTo },
  });
  // Changing the dates keeps the current list on screen (dimmed) while the new
  // range loads, instead of suspending the whole page.
  const updating = from !== deferredFrom || to !== deferredTo;

  return (
    <div className="space-y-6">
      <PageHeader title={dict.schedule.title} />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="from">{dict.schedule.from}</Label>
            <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div>
            <Label htmlFor="to">{dict.schedule.to}</Label>
            <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
          <button type="button" onClick={refetch} className="portal-link text-sm underline underline-offset-2 mb-2.5">
            {dict.schedule.apply}
          </button>
        </div>
      </Card>

      {loading ? (
        <LoadingState />
      ) : error || !data ? (
        <ErrorState onRetry={refetch} />
      ) : (
        <div className={`space-y-6 transition-opacity ${updating ? 'opacity-60' : ''}`} aria-busy={updating}>
          <Card>
            <h2 className="font-medium text-gray-900 mb-3">{dict.schedule.upcomingShifts}</h2>
            {data.shifts.length === 0 ? (
              <EmptyState message={dict.schedule.noShifts} />
            ) : (
              <ul className="divide-y divide-gray-100">
                {data.shifts.map((s) => (
                  <li key={s.id} className="py-2 flex justify-between text-sm">
                    <span className="text-gray-700">
                      {formatDateTime(s.startsAt, locale, timeZone)} – {formatDateTime(s.endsAt, locale, timeZone)}
                    </span>
                    <span className="text-gray-500">{s.companyName}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="font-medium text-gray-900 mb-3">{dict.schedule.attendanceRecords}</h2>
            {data.records.length === 0 ? (
              <EmptyState message={dict.schedule.noRecords} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-100">
                      <th className="py-2 pr-3 font-medium">{dict.schedule.date}</th>
                      <th className="py-2 pr-3 font-medium">{dict.schedule.worked}</th>
                      <th className="py-2 pr-3 font-medium">{dict.schedule.late}</th>
                      <th className="py-2 font-medium">{dict.schedule.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.records.map((r) => (
                      <tr key={r.id} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 pr-3 text-gray-700">{formatDate(r.date, locale, timeZone)}</td>
                        <td className="py-2 pr-3 text-gray-700">
                          {r.workedMinutes !== null ? format(dict.schedule.minutes, { minutes: r.workedMinutes }) : dict.common.none}
                        </td>
                        <td className="py-2 pr-3 text-gray-700">
                          {r.lateMinutes ? format(dict.schedule.minutes, { minutes: r.lateMinutes }) : dict.common.none}
                        </td>
                        <td className="py-2">
                          <Badge tone={r.approved ? 'positive' : 'warning'}>{r.approved ? dict.schedule.approved : dict.schedule.pending}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
