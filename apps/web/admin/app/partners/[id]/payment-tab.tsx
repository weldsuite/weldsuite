'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PARTNER_STATUSES, type PartnerStatus } from '@weldsuite/app-api-client/schemas/partners';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { overridePartnerStatus } from '@/actions/partners';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { PartnerStatusBadge } from '@/components/partners/badges';
import { formatDateTime, formatDay } from '@/lib/billing-format';
import { fill } from '@/lib/i18n';
import { currentContract, paymentOverview, pauseUntilIso } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';
import type { PartnerTabProps } from './partner-detail';

const PAUSE_DAYS = [7, 14, 30, 60] as const;

type Dialog = 'pause' | 'resume' | 'status';

export function PaymentTab({ detail, canWrite, nowIso }: Readonly<PartnerTabProps>) {
  const t = partnersCopy().payment;
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [pauseDays, setPauseDays] = useState<number>(14);
  const [status, setStatus] = useState<PartnerStatus>(detail.partner.status);

  const contract = currentContract(detail.contracts);
  const overview = paymentOverview({
    statements: detail.statements,
    contract,
    dunningPausedUntil: detail.partner.dunningPausedUntil,
    now: new Date(nowIso),
  });
  const close = () => {
    setDialog(null);
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent className="space-y-4 px-4">
          <div>
            <h2 className="text-sm font-medium">{t.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
          </div>

          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{t.current}</dt>
              <dd className="mt-1 flex items-center gap-2">
                <PartnerStatusBadge status={detail.partner.status} />
                {detail.partner.statusChangedAt && (
                  <span className="text-xs text-muted-foreground">{fill(t.changedAt, { date: formatDay(detail.partner.statusChangedAt) })}</span>
                )}
              </dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{t.sweepStage}</dt>
              <dd className="mt-1">
                <Badge variant={overview.stage === 'current' ? 'success' : overview.stage === 'suspended' ? 'destructive' : 'warning'}>
                  {partnersCopy().stage[overview.stage]}
                </Badge>
              </dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{t.clock}</dt>
              <dd className="mt-1 text-sm">
                {overview.paused && detail.partner.dunningPausedUntil
                  ? fill(t.clockPaused, { date: formatDateTime(detail.partner.dunningPausedUntil) })
                  : t.clockRunning}
              </dd>
            </div>
          </dl>

          <p className="text-xs text-muted-foreground">
            {contract ? fill(t.thresholds, { pastDue: contract.pastDueAfterDays, readOnly: contract.readOnlyAfterDays }) : null}
          </p>

          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{t.overdueInvoices}</h3>
            {overview.overdue.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noneOverdue}</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {overview.overdue.map((o) => (
                  <li key={o.statementId ?? o.periodStart} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="font-medium tabular-nums">{o.periodStart.slice(0, 7)}</span>
                    <span className="text-xs text-muted-foreground">{fill(t.due, { date: formatDay(o.dueAt) })}</span>
                    <Badge variant={o.stage === 'suspended' ? 'destructive' : o.stage === 'current' ? 'secondary' : 'warning'}>
                      {fill(t.daysOverdue, { count: o.daysOverdue })}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs text-muted-foreground">{t.clockHint}</p>

          {canWrite && (
            <div className="flex flex-wrap justify-end gap-2">
              {overview.paused ? (
                <Button variant="outline" onClick={() => setDialog('resume')}>
                  {t.resume}
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setDialog('pause')}>
                  {t.pause}
                </Button>
              )}
              <Button
                onClick={() => {
                  setStatus(detail.partner.status);
                  setDialog('status');
                }}
              >
                {t.setStatus}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {dialog === 'pause' && (
        <ActionDialog
          title={t.pauseTitle}
          description={t.pauseHint}
          submitLabel={t.pauseSubmit}
          onSubmit={(reason, requestId) =>
            overridePartnerStatus(detail.partner.id, { dunningPausedUntil: pauseUntilIso(pauseDays, new Date()), reason }, requestId)
          }
          successMessage={t.paused}
          onClose={close}
        >
          <Field label={t.pauseFor}>
            <Select value={String(pauseDays)} onValueChange={(v) => setPauseDays(Number(v))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAUSE_DAYS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {fill(t.pauseDays, { count: d })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </ActionDialog>
      )}

      {dialog === 'resume' && (
        <ActionDialog
          title={t.resumeTitle}
          description={t.resumeHint}
          submitLabel={t.resumeSubmit}
          onSubmit={(reason, requestId) => overridePartnerStatus(detail.partner.id, { dunningPausedUntil: null, reason }, requestId)}
          successMessage={t.resumed}
          onClose={close}
        />
      )}

      {dialog === 'status' && (
        <ActionDialog
          destructive={status === 'suspended'}
          title={t.setTitle}
          description={t.setHint}
          submitLabel={t.setSubmit}
          invalidMessage={status === detail.partner.status ? partnersCopy().profile.noChanges : null}
          onSubmit={(reason, requestId) => overridePartnerStatus(detail.partner.id, { status, reason }, requestId)}
          successMessage={t.statusSet}
          onClose={close}
        >
          <Field label={t.newStatus}>
            <Select value={status} onValueChange={(v) => setStatus(v as PartnerStatus)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PARTNER_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {partnersCopy().status[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </ActionDialog>
      )}
    </div>
  );
}
