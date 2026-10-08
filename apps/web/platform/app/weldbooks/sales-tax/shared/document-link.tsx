import { Link } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n/provider';

interface DocumentLinkProps {
  /** `invoice`, `credit_note`, `bill`, `bill_credit_note`, `journal_entry`, or a raw source type. */
  type: string;
  id: string | null | undefined;
  number?: string | null;
  /** Shown instead of the number and type label. */
  label?: string;
  className?: string;
}

const LINK_CLASS = 'text-primary hover:underline';

/** A document of the books by its number, linking to it when it has a page of its own. */
export function DocumentLink({ type, id, number, label, className }: Readonly<DocumentLinkProps>) {
  const { t } = useI18n();
  const types = t.weldbooksUs.salesTax.center.documentTypes as Record<string, string>;
  const text = label ?? number ?? types[type] ?? t.weldbooksUs.salesTax.center.common.unknownDocument;
  const cls = className ?? LINK_CLASS;

  if (!id) return <span className={className}>{text}</span>;
  if (type === 'invoice' || type === 'credit_note' || type === 'write_off' || type === 'bad_debt') {
    return (
      <Link to="/weldbooks/invoices/$id" params={{ id }} className={cls}>
        {text}
      </Link>
    );
  }
  if (type === 'bill' || type === 'bill_credit_note') {
    return (
      <Link to="/weldbooks/bills/$id" params={{ id }} className={cls}>
        {text}
      </Link>
    );
  }
  if (type === 'journal_entry') {
    return (
      <Link to="/weldbooks/journal/$id" params={{ id }} className={cls}>
        {text}
      </Link>
    );
  }
  return <span className={className}>{text}</span>;
}
