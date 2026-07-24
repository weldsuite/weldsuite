import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import { Badge } from '@weldsuite/ui/components/badge';
import { FileMinus } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  EmptyStateIllustration,
  type ColumnDef,
} from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

interface CreditNoteRow {
  id: string;
  invoiceNumber: string | null;
  contactName: string | null;
  issueDate: string | null;
  creditNoteForInvoiceId: string | null;
  total: string | number | null;
  currency: string | null;
  status: string;
}

function statusVariant(status: string) {
  switch (status) {
    case 'paid':
      return 'default' as const;
    case 'sent':
      return 'secondary' as const;
    case 'draft':
      return 'outline' as const;
    default:
      return 'secondary' as const;
  }
}

/**
 * Credit notes are invoices with type='credit_note'. They're created from the detail
 * view of a finalized invoice via `POST /accounting/invoices/:id/credit-note`, so this
 * page is a read-only list — no "New" button. Use the source invoice to generate one.
 */
export default function CreditNotesPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useAccountingInvoices({ type: 'credit_note', search });
  const navigate = useNavigate();
  const { t } = useI18n();
  const tcn = t.accounting.creditNotesPage;
  const tsl = t.accounting.statusLabels.invoice;

  const creditNotes = (data?.data ?? []) as unknown as CreditNoteRow[];

  const columns: ColumnDef<CreditNoteRow>[] = [
    {
      id: 'number',
      header: tcn.colNumber,
      width: 'flex-1',
      render: (cn) => <span className="font-medium">{cn.invoiceNumber}</span>,
    },
    {
      id: 'contact',
      header: tcn.colContact,
      width: 'flex-1',
      render: (cn) => <span className="text-muted-foreground">{cn.contactName ?? '—'}</span>,
    },
    {
      id: 'date',
      header: tcn.colDate,
      width: 'w-[140px]',
      render: (cn) => <span className="text-muted-foreground">{cn.issueDate ?? '—'}</span>,
    },
    {
      id: 'source',
      header: tcn.colForInvoice,
      width: 'w-[160px]',
      render: (cn) =>
        cn.creditNoteForInvoiceId ? (
          <Link
            to="/weldbooks/invoices/$id"
            params={{ id: cn.creditNoteForInvoiceId }}
            onClick={(e) => e.stopPropagation()}
            className="text-primary hover:underline text-sm"
          >
            {tcn.viewSource}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'total',
      header: tcn.colTotal,
      width: 'w-[140px]',
      render: (cn) => (
        <span>
          {new Intl.NumberFormat('nl-NL', {
            style: 'currency',
            currency: cn.currency || 'EUR',
          }).format(Number(cn.total ?? 0))}
        </span>
      ),
    },
    {
      id: 'status',
      header: tcn.colStatus,
      width: 'w-[140px]',
      render: (cn) => (
        <Badge variant={statusVariant(cn.status)}>
          {tsl[cn.status as keyof typeof tsl] ?? cn.status}
        </Badge>
      ),
    },
  ];

  return (
    <WeldbooksEntityList<CreditNoteRow>
      items={creditNotes}
      isLoading={isLoading}
      columns={columns}
      onRowClick={(cn) => navigate({ to: '/weldbooks/invoices/$id', params: { id: cn.id } })}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder={tcn.searchPlaceholder}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <FileMinus className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tcn.noCreditNotes,
        description: tcn.searchPlaceholder,
      }}
    />
  );
}
