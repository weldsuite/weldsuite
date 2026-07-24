import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import { Badge } from '@weldsuite/ui/components/badge';
import { FileText } from 'lucide-react';
import { EmptyStateIllustration, type ColumnDef, type GroupConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { InvoiceDialog } from './components/invoice-dialog';
import { useI18n } from '@/lib/i18n/provider';

interface InvoiceRow {
  id: string;
  invoiceNumber: string | null;
  contactName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  status: string;
}

function statusVariant(status: string) {
  switch (status) {
    case 'paid':
      return 'default' as const;
    case 'sent':
      return 'secondary' as const;
    case 'overdue':
      return 'destructive' as const;
    case 'draft':
      return 'outline' as const;
    default:
      return 'secondary' as const;
  }
}

function formatCurrency(value: number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Number(value ?? 0));
}

export default function InvoicesPage() {
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data, isLoading } = useAccountingInvoices({ search });
  const navigate = useNavigate();
  const { t } = useI18n();
  const tip = t.accounting.invoicesPage;
  const tsl = t.accounting.statusLabels.invoice;

  const invoices = (data?.data ?? []) as unknown as InvoiceRow[];

  // Group by lifecycle status, most-urgent first. The trailing "other" group is
  // an explicit catch-all: EntityList drops items matching no group, so any
  // status outside the known set (e.g. cancelled/void) stays visible here.
  const knownStatuses = ['overdue', 'sent', 'partial', 'draft', 'paid'];
  const groups: GroupConfig<InvoiceRow>[] = [
    { id: 'overdue', label: tip.groupOverdue, sortOrder: 1, filter: (i) => i.status === 'overdue' },
    { id: 'sent', label: tip.groupSent, sortOrder: 2, filter: (i) => i.status === 'sent' || i.status === 'partial' },
    { id: 'draft', label: tip.groupDraft, sortOrder: 3, filter: (i) => i.status === 'draft' },
    { id: 'paid', label: tip.groupPaid, sortOrder: 4, filter: (i) => i.status === 'paid' },
    { id: 'other', label: tip.groupOther, sortOrder: 5, filter: (i) => !knownStatuses.includes(i.status) },
  ];

  const columns: ColumnDef<InvoiceRow>[] = [
    {
      id: 'number',
      header: tip.colNumber,
      width: 'flex-1',
      render: (inv) => <span className="font-medium">{inv.invoiceNumber}</span>,
    },
    {
      id: 'contact',
      header: tip.colContact,
      width: 'flex-1',
      render: (inv) => <span className="text-muted-foreground">{inv.contactName ?? '—'}</span>,
    },
    {
      id: 'issueDate',
      header: tip.colDate,
      width: 'w-[140px]',
      render: (inv) => <span className="text-muted-foreground">{inv.issueDate ?? '—'}</span>,
    },
    {
      id: 'dueDate',
      header: tip.colDueDate,
      width: 'w-[140px]',
      render: (inv) => <span className="text-muted-foreground">{inv.dueDate ?? '—'}</span>,
    },
    {
      id: 'total',
      header: tip.colTotal,
      width: 'w-[140px]',
      render: (inv) => formatCurrency(inv.totalAmount),
    },
    {
      id: 'status',
      header: tip.colStatus,
      width: 'w-[140px]',
      render: (inv) => (
        <Badge variant={statusVariant(inv.status)}>{tsl[inv.status as keyof typeof tsl] ?? inv.status}</Badge>
      ),
    },
  ];

  return (
    <>
      <WeldbooksEntityList<InvoiceRow>
        items={invoices}
        isLoading={isLoading}
        columns={columns}
        groups={groups}
        onRowClick={(inv) => navigate({ to: '/weldbooks/invoices/$id', params: { id: inv.id } })}
        filters={[]}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={tip.searchPlaceholder}
        createButton={{
          label: tip.newInvoice,
          onClick: () => setDialogOpen(true),
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <FileText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tip.noInvoices,
          description: tip.searchPlaceholder,
          action: {
            label: tip.newInvoice,
            onClick: () => setDialogOpen(true),
          },
        }}
      />

      <InvoiceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(inv) => navigate({ to: '/weldbooks/invoices/$id', params: { id: inv.id } })}
      />
    </>
  );
}
