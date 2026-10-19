import { useState } from 'react';
import { useAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import { FileMinus } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  ContactCell,
  EmptyCell,
  RowAmount,
  RowDate,
  RowText,
  RowTitle,
  StatusChip,
} from '@/components/accounting/weldbooks-row-cells';
import {
  EmptyStateIllustration,
  type ColumnDef,
} from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

interface CreditNoteRow {
  id: string;
  invoiceNumber: string | null;
  contactName: string | null;
  issueDate: string | null;
  creditNoteForInvoiceId: string | null;
  // Sent by books-api with the list; absent from older deploys.
  creditNoteForInvoiceNumber?: string | null;
  total: string | number | null;
  currency: string | null;
  status: string;
}

/**
 * Credit notes are invoices with type='credit_note'. They're created from the detail
 * view of a finalized invoice via `POST /accounting/invoices/:id/credit-note`, so this
 * page is a read-only list — no "New" button. Use the source invoice to generate one.
 */
export default function CreditNotesPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useAccountingInvoices({ type: 'credit_note', search });
  // A credit note is an invoice of type 'credit_note': it opens in the invoice
  // panel, synced to `?stack=` on this page.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/credit-notes');
  const { t } = useI18n();
  const tcn = t.accounting.creditNotesPage;
  const tsl = t.accounting.statusLabels.invoice;
  const { formatMoney, formatDate } = useWeldbooksFormat();

  const creditNotes = (data?.data ?? []) as unknown as CreditNoteRow[];

  const columns: ColumnDef<CreditNoteRow>[] = [
    {
      id: 'number',
      header: tcn.colNumber,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (cn) => <RowTitle>{cn.invoiceNumber ?? '—'}</RowTitle>,
    },
    {
      id: 'contact',
      header: tcn.colContact,
      width: 'w-[200px]',
      render: (cn) => <ContactCell name={cn.contactName} />,
    },
    {
      id: 'date',
      header: tcn.colDate,
      width: 'w-[120px]',
      render: (cn) => <RowDate>{formatDate(cn.issueDate)}</RowDate>,
    },
    {
      id: 'source',
      header: tcn.colForInvoice,
      width: 'w-[130px]',
      render: (cn) => {
        const sourceId = cn.creditNoteForInvoiceId;
        if (!sourceId) return <EmptyCell />;
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openPanel({ type: 'invoice', id: sourceId });
            }}
            className="min-w-0 text-left"
          >
            <RowText>{cn.creditNoteForInvoiceNumber ?? tcn.viewSource}</RowText>
          </button>
        );
      },
    },
    {
      id: 'total',
      header: tcn.colTotal,
      width: 'w-[130px]',
      render: (cn) => <RowAmount>{formatMoney(cn.total, cn.currency)}</RowAmount>,
    },
    {
      id: 'status',
      header: tcn.colStatus,
      width: 'w-[110px]',
      render: (cn) => (
        <StatusChip status={cn.status}>{tsl[cn.status as keyof typeof tsl] ?? cn.status}</StatusChip>
      ),
    },
  ];

  return (
    <WeldbooksEntityList<CreditNoteRow>
      items={creditNotes}
      isLoading={isLoading}
      columns={columns}
      onRowClick={(cn) => openPanel({ type: 'invoice', id: cn.id })}
      getRowLabel={(cn) => cn.invoiceNumber ?? tcn.colNumber}
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
        description: tcn.emptyDescription,
      }}
    />
  );
}
