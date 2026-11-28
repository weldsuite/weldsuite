import { RecordLink } from '@/components/object-panel/record-link';
import { useI18n } from '@/lib/i18n/provider';
import { documentRecord } from '@/lib/weldbooks/record-links';

interface DocumentLinkProps {
  /** `invoice`, `credit_note`, `bill`, `bill_credit_note`, `journal_entry`, or a raw source type. */
  type: string;
  id: string | null | undefined;
  number?: string | null;
  /** Shown instead of the number and type label. */
  label?: string;
  className?: string;
}

const LINK_CLASS = 'min-h-0 border-transparent bg-transparent px-0 py-0 text-primary hover:bg-transparent hover:underline';

/**
 * A document of the books by its number. It stacks the document's panel over
 * the page (Cmd/Ctrl-click opens it in a new tab) when the document has one.
 */
export function DocumentLink({ type, id, number, label, className }: Readonly<DocumentLinkProps>) {
  const { t } = useI18n();
  const types = t.weldbooksUs.salesTax.center.documentTypes as Record<string, string>;
  const text = label ?? number ?? types[type] ?? t.weldbooksUs.salesTax.center.common.unknownDocument;

  const record = documentRecord(type, id);
  if (!record) return <span className={className}>{text}</span>;
  return <RecordLink type={record.type} id={record.id} label={text} icon={null} className={className ?? LINK_CLASS} />;
}
