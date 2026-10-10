/** One filing: its figures per line, payment reference, and the status history. */

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollFiling } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { EmptyText } from '../../components/page-kit';
import { formatDate, formatDateTime } from '../../components/shared';
import { countryCurrency, formatCents, formatDecimal, humanizeKey, periodRange } from '../lib/format';
import { FilingStatusBadge, InfoLine, ValueRow } from './payroll-ui';

export function FilingSheet({ filing, onClose }: Readonly<{ filing: HrPayrollFiling; onClose: () => void }>) {
  const t = useTranslations();
  const currency = countryCurrency(filing.country);
  const lines = Object.entries(filing.summary);
  const kind = t(`weldhr.payroll.filingKind.${filing.kind}`);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{filing.state ? `${kind} · ${filing.state}` : kind}</SheetTitle>
          <SheetDescription>
            {filing.employerName} · {periodRange(filing.periodStart, filing.periodEnd)}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <FilingStatusBadge status={filing.status} />
            <span className="text-xs text-muted-foreground">{t('weldhr.payroll.filings.version', { version: filing.version })}</span>
          </div>

          {filing.country === 'US' && <InfoLine>{t('weldhr.payroll.filings.usNote')}</InfoLine>}

          <div className="grid gap-4 sm:grid-cols-2">
            <ValueRow label={t('weldhr.payroll.filings.table.dueDate')}>{formatDate(filing.dueDate)}</ValueRow>
            <ValueRow label={t('weldhr.payroll.filings.table.amountDue')}>{formatDecimal(filing.amountDue, currency)}</ValueRow>
            <ValueRow label={t('weldhr.payroll.filings.paymentReference')}>
              {filing.paymentReference ? <span className="font-mono">{filing.paymentReference}</span> : null}
            </ValueRow>
            <ValueRow label={t('weldhr.payroll.filings.file')}>{filing.fileName}</ValueRow>
            {filing.channel && <ValueRow label={t('weldhr.payroll.filings.channel')}>{t(`weldhr.payroll.filings.channels.${filing.channel}`)}</ValueRow>}
            {filing.externalReference && <ValueRow label={t('weldhr.payroll.filings.externalReference')}>{filing.externalReference}</ValueRow>}
            {filing.submittedAt && <ValueRow label={t('weldhr.payroll.filings.submittedAt')}>{formatDateTime(filing.submittedAt)}</ValueRow>}
          </div>

          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('weldhr.payroll.filings.figures')}</h3>
            {lines.length === 0 ? (
              <EmptyText>{t('weldhr.payroll.filings.noFigures')}</EmptyText>
            ) : (
              <dl className="divide-y rounded-md border text-sm">
                {lines.map(([key, cents]) => (
                  <div key={key} className="flex items-center justify-between gap-3 px-3 py-2">
                    <dt className="text-muted-foreground">{humanizeKey(key)}</dt>
                    <dd className="tabular-nums">{formatCents(cents, currency)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          {filing.history.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('weldhr.payroll.filings.history')}</h3>
              <ul className="space-y-1.5 text-sm">
                {[...filing.history].reverse().map((event) => (
                  <li key={`${event.at}-${event.status}`} className="flex flex-wrap items-center gap-2">
                    <FilingStatusBadge status={event.status} />
                    <span className="text-muted-foreground">{formatDateTime(event.at)}</span>
                    {event.message && <span>{event.message}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
