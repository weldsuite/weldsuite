'use client';

import { useParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useMe } from '@/lib/me-context';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { PortalApiError, portalPost } from '@/lib/client';
import { formatDate, todayIso } from '@/lib/date';
import type { EmployeeLeave, LeaveRequest } from '@/lib/types';
import { Button, Card, Input, Label, PageHeader, Select, Textarea } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

const STATUS_TONE = { pending: 'warning', approved: 'positive', rejected: 'negative', cancelled: 'neutral' } as const;

export default function LeaveView() {
  const slug = String(useParams().workspace ?? '');
  const me = useMe();
  const { dict, locale, format, timeZone } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<EmployeeLeave>(slug, '/employee/leave');

  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const canRequest = me.kind === 'employee' && me.config.features.leaveRequests;

  async function submitRequest(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await portalPost<LeaveRequest>(slug, '/employee/leave', {
        leaveTypeId: leaveTypeId || data?.types[0]?.id,
        startDate,
        endDate,
        reason: reason || null,
      });
      setReason('');
      refetch();
    } catch (err) {
      if (err instanceof PortalApiError && err.status === 409) setFormError(dict.leave.overlapError);
      else setFormError(err instanceof Error ? err.message : dict.errors.generic);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(id: string) {
    setCancellingId(id);
    try {
      await portalPost<LeaveRequest>(slug, `/employee/leave/${id}/cancel`);
      refetch();
    } finally {
      setCancellingId(null);
    }
  }

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  return (
    <div className="space-y-6">
      <PageHeader title={dict.leave.title} />

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.leave.balances}</h2>
        {data.balances.length === 0 ? (
          <EmptyState message={dict.leave.empty} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.balances.map((b) => (
              <div key={b.leaveTypeId} className="rounded-md border border-gray-100 p-3">
                <p className="text-sm font-medium text-gray-900">{b.name}</p>
                <dl className="mt-1 text-xs text-gray-500 space-y-0.5">
                  <div className="flex justify-between">
                    <dt>{dict.leave.allowance}</dt>
                    <dd>{b.allowance ?? dict.leave.unlimited}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>{dict.leave.used}</dt>
                    <dd>{b.used}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>{dict.leave.pending}</dt>
                    <dd>{b.pending}</dd>
                  </div>
                  <div className="flex justify-between font-medium text-gray-700">
                    <dt>{dict.leave.remaining}</dt>
                    <dd>{b.remaining ?? dict.leave.unlimited}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.leave.requestLeave}</h2>
        {!canRequest ? (
          <p className="text-sm text-gray-500">{dict.leave.disabled}</p>
        ) : (
          <form onSubmit={submitRequest} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="leaveType">{dict.leave.leaveType}</Label>
                <Select id="leaveType" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} required>
                  <option value="" disabled>
                    {dict.leave.leaveType}
                  </option>
                  {data.types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="startDate">{dict.leave.startDate}</Label>
                <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="endDate">{dict.leave.endDate}</Label>
                <Input id="endDate" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} required />
              </div>
            </div>
            <div>
              <Label htmlFor="reason">
                {dict.leave.reason} <span className="text-gray-400 font-normal">({dict.common.optional})</span>
              </Label>
              <Textarea id="reason" rows={3} placeholder={dict.leave.reasonPlaceholder} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <Button type="submit" disabled={submitting || !leaveTypeId}>
              {dict.leave.submitRequest}
            </Button>
          </form>
        )}
      </Card>

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.leave.history}</h2>
        {data.requests.length === 0 ? (
          <EmptyState message={dict.leave.empty} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.requests.map((r) => (
              <li key={r.id} className="py-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-gray-900">{r.leaveTypeName}</p>
                  <p className="text-xs text-gray-500">
                    {formatDate(r.startDate, locale, timeZone)} – {formatDate(r.endDate, locale, timeZone)} ·{' '}
                    {format(r.days === 1 ? dict.leave.days : dict.leave.daysPlural, { days: r.days })}
                  </p>
                  {r.reason && <p className="text-xs text-gray-500 mt-0.5">{r.reason}</p>}
                  {r.reviewNote && <p className="text-xs text-gray-500 mt-0.5">{r.reviewNote}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[r.status]}>{dict.leave.status[r.status]}</Badge>
                  {r.status === 'pending' && (
                    <button
                      type="button"
                      disabled={cancellingId === r.id}
                      onClick={() => void cancel(r.id)}
                      className="text-xs text-gray-500 underline underline-offset-2 disabled:opacity-50"
                    >
                      {dict.leave.cancelRequest}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
