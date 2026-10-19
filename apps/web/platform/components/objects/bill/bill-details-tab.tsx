/**
 * Details tab of the bill panel: the money at a glance, the supplier, dates,
 * reference, delivery address, notes and the original documents.
 */

import { useState } from 'react';
import {
  Banknote,
  Building2,
  Calendar,
  CalendarClock,
  FileText,
  Hash,
  Loader2,
  Lock,
  MapPin,
  Scale,
  StickyNote,
  Truck,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { countryName } from '@/components/address/countries';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import type { BillWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { cn } from '@/lib/utils';

const EMPTY = '—';

/** A value that runs over several lines: an address, a note. */
function renderLines(lines: readonly string[]) {
  return (
    <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{lines.join('\n')}</span>
  );
}

function OriginalDocuments({ billId, keys }: Readonly<{ billId: string; keys: readonly string[] }>) {
  const { t } = useI18n();
  const tb = t.accounting.billDetail;
  const [opening, setOpening] = useState<number | null>(null);

  const open = async (index: number, fallbackName: string) => {
    setOpening(index);
    try {
      const { blob, filename } = await accountingApi.getBillAttachment(billId, index);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = filename || fallbackName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(tb.failedToOpenAttachment);
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium text-foreground">{tb.originalDocuments}</h3>
      <TabListScope>
        <div className="-mx-4 border-t border-gray-200/70 dark:border-border">
          {keys.map((key, index) => {
            const name = key.split('/').pop() || tb.attachmentFallback.replace('{n}', String(index + 1));
            return (
              <TabListRow
                key={`${key}-${index}`}
                label={`${tb.openAttachment}: ${name}`}
                onOpen={opening === null ? () => void open(index, name) : undefined}
              >
                <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                {opening === index ? (
                  <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" />
                ) : null}
              </TabListRow>
            );
          })}
        </div>
      </TabListScope>
    </div>
  );
}

export function BillDetailsTab({ bill }: Readonly<{ bill: BillWithTax }>) {
  const { t, language } = useI18n();
  const st = useTranslations();
  const tb = t.accounting.billDetail;
  const td = useDocumentTexts();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { features } = useJurisdictionLabels();

  const toLines = (address: BillWithTax['vendorAddress']) =>
    formatPostalAddressLines(normalizeAccountingAddress(address), {
      countryName: (code) => countryName(code, language),
    });
  const vendorAddressLines = toLines(bill.vendorAddress);
  const deliveryLines = toLines(bill.deliveryAddress);
  const attachments = bill.attachmentKeys ?? [];
  const balanceOpen = Number(bill.balanceDue) > 0;

  return (
    <div className="@container space-y-4 p-4">
      <div className="space-y-1">
        <PropertyRow icon={Banknote} label={tb.total} value={formatMoney(bill.total, bill.currency)} readOnly />
        <PropertyRow icon={Wallet} label={tb.paid} value={formatMoney(bill.amountPaid, bill.currency)} readOnly />
        <PropertyRow
          icon={Scale}
          label={tb.balanceDue}
          value={formatMoney(bill.balanceDue, bill.currency)}
          readOnly
          renderValue={(value) => <span className={cn(balanceOpen && 'text-destructive')}>{value}</span>}
        />
        <PropertyRow icon={Building2} label={st('sweep.entities.fieldSupplier')} value={bill.contactName} placeholder={EMPTY} readOnly />
        {vendorAddressLines.length > 0 ? (
          <PropertyRow
            icon={MapPin}
            label={st('sweep.entities.fieldAddress')}
            value={vendorAddressLines.join('\n')}
            readOnly
            renderValue={() => renderLines(vendorAddressLines)}
          />
        ) : null}
        <PropertyRow
          icon={Calendar}
          label={st('sweep.entities.fieldIssueDate')}
          value={formatDate(bill.issueDate)}
          placeholder={EMPTY}
          tabular
          readOnly
        />
        <PropertyRow
          icon={CalendarClock}
          label={st('sweep.entities.fieldDueDate')}
          value={formatDate(bill.dueDate)}
          placeholder={EMPTY}
          tabular
          readOnly
        />
        <PropertyRow icon={Hash} label={tb.reference} value={bill.externalReference} placeholder={EMPTY} readOnly />
        {features.salesTax && deliveryLines.length > 0 ? (
          <PropertyRow
            icon={Truck}
            label={td.bill.deliveryTitle}
            value={deliveryLines.join('\n')}
            readOnly
            renderValue={() => renderLines(deliveryLines)}
          />
        ) : null}
        {bill.notes ? (
          <PropertyRow
            icon={StickyNote}
            label={tb.notes}
            value={bill.notes}
            readOnly
            renderValue={(value) => renderLines([value ?? ''])}
          />
        ) : null}
        {bill.internalNotes ? (
          <PropertyRow
            icon={Lock}
            label={tb.internalNotes}
            value={bill.internalNotes}
            readOnly
            renderValue={(value) => renderLines([value ?? ''])}
          />
        ) : null}
      </div>

      {attachments.length > 0 ? <OriginalDocuments billId={bill.id} keys={attachments} /> : null}
    </div>
  );
}
