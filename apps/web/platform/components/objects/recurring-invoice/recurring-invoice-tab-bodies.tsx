/**
 * The Details and Template items tabs of the recurring invoice panel.
 */

import {
  CalendarClock,
  CalendarDays,
  CalendarX,
  CircleDot,
  FileCheck2,
  Hash,
  History,
  ListOrdered,
  Receipt,
  Repeat,
  Send,
  User,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { TabEmptyIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import type { RecurringInvoice } from '@/lib/api/domains/weldbooks';
import type { RecurringTemplateTaxItem } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { isWeldTaxCode } from '@/lib/weldbooks/tax-codes';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { RECURRING_FREQUENCIES, type RecurringFrequency } from '@/app/weldbooks/recurring/components/recurring-payload';

const EMPTY = '—';

function isFrequency(value: string): value is RecurringFrequency {
  return (RECURRING_FREQUENCIES as readonly string[]).includes(value);
}

/** The status chip of a template: running, paused or ended. */
export function RecurringStatusChip({ status }: Readonly<{ status: string }>) {
  const { t } = useI18n();
  const labels = t.accounting.statusLabels.recurringInvoice as Record<string, string>;
  return <StatusChip status={status}>{labels[status] ?? status}</StatusChip>;
}

export function RecurringDetailsTab({
  recurring,
  customerName,
  onOpenInvoice,
}: Readonly<{
  recurring: RecurringInvoice;
  customerName: string | null;
  onOpenInvoice: (id: string) => void;
}>) {
  const { t } = useI18n();
  const st = useTranslations();
  const td = useDocumentTexts();
  const trp = t.accounting.recurringPage;
  const { formatDate, formatDateTime } = useWeldbooksFormat();
  const yesNo = (value: boolean | null) => (value ? trp.yes : trp.no);
  const frequency = isFrequency(recurring.frequency)
    ? td.recurring.frequencies[recurring.frequency]
    : recurring.frequency;

  return (
    <div className="@container">
      <div className="p-4 space-y-4">
        <div className="space-y-1">
          <PropertyRow icon={CalendarClock} label={trp.nextIssueDate} value={formatDate(recurring.nextIssueDate)} tabular readOnly />
          <PropertyRow icon={Hash} label={trp.generatedCount} value={String(recurring.generatedCount ?? 0)} readOnly />
          <PropertyRow
            icon={History}
            label={trp.lastGenerated}
            value={formatDateTime(recurring.lastGeneratedAt, trp.never)}
            tabular
            readOnly
          />
          <PropertyRow
            icon={CircleDot}
            label={st('sweep.entities.fieldStatus')}
            value={recurring.status}
            readOnly
            renderValue={(status) => <RecurringStatusChip status={status ?? ''} />}
          />
          <PropertyRow icon={User} label={td.recurring.customer} value={customerName} placeholder={EMPTY} readOnly />
          <PropertyRow icon={Repeat} label={trp.frequency} value={frequency} placeholder={EMPTY} readOnly />
          {recurring.dayOfMonth ? (
            <PropertyRow
              icon={CalendarDays}
              label={trp.dayOfMonth}
              value={String(recurring.dayOfMonth)}
              readOnly
            />
          ) : null}
          {recurring.endDate ? (
            <PropertyRow icon={CalendarX} label={trp.endDate} value={formatDate(recurring.endDate)} tabular readOnly />
          ) : null}
          <PropertyRow icon={FileCheck2} label={trp.autoFinalize} value={yesNo(recurring.autoFinalize)} readOnly />
          <PropertyRow icon={Send} label={trp.autoSend} value={yesNo(recurring.autoSend)} readOnly />
          {recurring.lastGeneratedInvoiceId ? (
            <PropertyRow
              icon={Receipt}
              label={trp.lastInvoice}
              value={recurring.lastGeneratedInvoiceId}
              readOnly
              renderValue={(invoiceId) => (
                <button
                  type="button"
                  className="min-w-0 truncate text-primary hover:underline"
                  onClick={() => onOpenInvoice(invoiceId ?? '')}
                >
                  {td.recurring.openInvoice}
                </button>
              )}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Builds stable keys for id-less template items (duplicates get an occurrence suffix). */
function withItemKeys<T extends { description?: string; quantity?: number; unitPrice?: number }>(
  list: T[],
): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return list.map((item) => {
    const base = `${item.description ?? ''}|${item.quantity ?? ''}|${item.unitPrice ?? ''}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: `${base}#${occurrence}`, item };
  });
}

export function RecurringItemsTab({
  items,
  currency,
}: Readonly<{ items: RecurringTemplateTaxItem[]; currency: string | undefined }>) {
  const { t } = useI18n();
  const td = useDocumentTexts();
  const trp = t.accounting.recurringPage;
  const { formatMoney } = useWeldbooksFormat();

  /** The tax settings of a template line, when they are not the defaults. */
  const lineFlags = (item: RecurringTemplateTaxItem): string[] => {
    const flags: string[] = [];
    if (item.taxCode) flags.push(isWeldTaxCode(item.taxCode) ? td.taxCodes[item.taxCode] : item.taxCode);
    if (item.taxUse === 'business') flags.push(td.detail.lineFlags.business);
    if (item.taxUse === 'personal') flags.push(td.detail.lineFlags.personal);
    if (item.taxIncluded) flags.push(td.detail.lineFlags.taxIncluded);
    return flags;
  };

  if (items.length === 0) {
    return (
      <TabEmptyState
        bare
        illustration={
          <TabEmptyIllustration>
            <ListOrdered className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </TabEmptyIllustration>
        }
        title={trp.noTemplateItems}
        description={trp.noTemplateItemsDescription}
      />
    );
  }

  return (
    <TabListScope>
      <div className="border-t border-gray-200/70 dark:border-border">
        {withItemKeys(items).map(({ key, item }) => {
          const flags = lineFlags(item);
          return (
            <TabListRow key={key} label={item.description}>
              <div className="min-w-0 flex-1">
                <div className="break-words text-sm">{item.description}</div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {item.quantity} × {formatMoney(item.unitPrice, currency)}
                </div>
                {flags.length > 0 && <div className="text-xs text-muted-foreground">{flags.join(' · ')}</div>}
              </div>
              <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">
                {formatMoney((item.quantity ?? 1) * (item.unitPrice ?? 0), currency)}
              </span>
            </TabListRow>
          );
        })}
      </div>
    </TabListScope>
  );
}
