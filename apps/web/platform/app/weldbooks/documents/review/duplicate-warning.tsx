/**
 * The duplicate check of the review screen: bills of the same supplier with the
 * same invoice number, and documents with the same file, each as a chip to open.
 * Shown only when something was found.
 */

import { FileText } from 'lucide-react';
import { RecordChip } from '@weldsuite/ui/components/record-chip';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { RecordLink } from '@/components/object-panel/record-link';
import type { DocumentDuplicates } from '@/lib/api/domains/weldbooks-receipts';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { toPublicPath } from '@/lib/workspace-url-rewrite';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

export function hasDuplicates(duplicates: DocumentDuplicates | undefined): boolean {
  return Boolean(duplicates && (duplicates.bills.length > 0 || duplicates.documents.length > 0));
}

export function DuplicateWarning({ duplicates }: Readonly<{ duplicates: DocumentDuplicates | undefined }>) {
  const { t } = useI18n();
  const td = t.weldbooksReceipts.review.duplicates;
  const router = useRouter();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  if (!duplicates || !hasDuplicates(duplicates)) return null;

  return (
    <div data-testid="duplicate-warning">
    <InfoBanner variant="warning" title={td.title}>
      <div className="mt-2 space-y-2">
        {duplicates.bills.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">{td.bills}</p>
            <ul className="flex flex-wrap gap-2">
              {duplicates.bills.map((bill) => (
                <li key={bill.id} className="min-w-0">
                  <RecordLink
                    type="bill"
                    id={bill.id}
                    label={bill.billNumber ? td.bill.replace('{number}', bill.billNumber) : td.billFallback}
                    secondary={[bill.contactName, bill.total ? formatMoney(bill.total, bill.currency) : null, formatDate(bill.issueDate)]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {duplicates.documents.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">{td.documents}</p>
            <ul className="flex flex-wrap gap-2">
              {duplicates.documents.map((doc) => {
                const href = `/weldbooks/documents/${encodeURIComponent(doc.id)}/review`;
                return (
                  <li key={doc.id} className="min-w-0">
                    <RecordChip
                      label={td.document.replace('{name}', doc.originalFileName ?? doc.fileName)}
                      secondary={doc.linkedEntityType ? td.linkedTo : formatDate(doc.createdAt)}
                      icon={FileText}
                      href={toPublicPath(href)}
                      onOpen={() => router.push(href)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </InfoBanner>
    </div>
  );
}
