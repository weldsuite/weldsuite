
import { FileText, Plus, CheckCircle, Clock, AlertCircle, XCircle, MoreHorizontal, Download, Send } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import type { InvoicesSectionProps, CustomerInvoice } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

const statusConfig: Record<string, { icon: typeof Clock; color: string; bg: string }> = {
  draft: { icon: FileText, color: 'text-gray-600', bg: 'bg-gray-100' },
  sent: { icon: Send, color: 'text-blue-600', bg: 'bg-blue-100' },
  pending: { icon: Clock, color: 'text-yellow-600', bg: 'bg-yellow-100' },
  paid: { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-100' },
  overdue: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-100' },
  cancelled: { icon: XCircle, color: 'text-gray-600', bg: 'bg-gray-100' },
};

function formatCurrency(amount: string | number, currency = 'USD'): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(num);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function InvoicesSection({ invoices, totalCount }: InvoicesSectionProps) {
  const t = useTranslations();
  // Calculate totals
  const totalValue = invoices.reduce((sum, inv) => sum + parseFloat(inv.amount || '0'), 0);
  const paidInvoices = invoices.filter(inv => inv.status === 'paid');
  const paidValue = paidInvoices.reduce((sum, inv) => sum + parseFloat(inv.amount || '0'), 0);
  const pendingInvoices = invoices.filter(inv => inv.status === 'pending' || inv.status === 'sent');
  const overdueInvoices = invoices.filter(inv => inv.status === 'overdue');

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-medium text-foreground">{t('sweep.weldcrm.invoicesSection.invoices')}</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.invoicesSection.invoiceCount', { count: totalCount })}</span>
          <Button size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('sweep.weldcrm.invoicesSection.newInvoice')}
          </Button>
        </div>
      </div>

      {invoices.length === 0 ? (
        <div className="text-center py-12">
          <FileText className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">{t('sweep.weldcrm.invoicesSection.noInvoicesYet')}</h3>
          <p className="text-sm text-muted-foreground mb-4">{t('sweep.weldcrm.invoicesSection.noInvoicesYetDescription')}</p>
          <Button className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('sweep.weldcrm.invoicesSection.createInvoice')}
          </Button>
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="bg-background border border-border rounded-lg p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('sweep.weldcrm.invoicesSection.totalInvoiced')}</p>
              <p className="text-xl font-semibold text-foreground">
                {formatCurrency(totalValue)}
              </p>
            </div>
            <div className="bg-background border border-border rounded-lg p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('sweep.weldcrm.invoicesSection.paid')}</p>
              <p className="text-xl font-semibold text-green-600">
                {formatCurrency(paidValue)}
              </p>
            </div>
            <div className="bg-background border border-border rounded-lg p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('sweep.weldcrm.invoicesSection.pending')}</p>
              <p className="text-xl font-semibold text-yellow-600">
                {formatCurrency(totalValue - paidValue)}
              </p>
              <p className="text-xs text-muted-foreground">{t('sweep.weldcrm.invoicesSection.invoiceCount', { count: pendingInvoices.length })}</p>
            </div>
            <div className="bg-background border border-border rounded-lg p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('sweep.weldcrm.invoicesSection.overdue')}</p>
              <p className="text-xl font-semibold text-red-600">
                {overdueInvoices.length}
              </p>
              <p className="text-xs text-muted-foreground">{t('sweep.weldcrm.invoicesSection.invoices')}</p>
            </div>
          </div>

          {/* Invoices List */}
          <div className="space-y-2">
            {invoices.map((invoice) => (
              <InvoiceCard key={invoice.id} invoice={invoice} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function InvoiceCard({ invoice }: { invoice: CustomerInvoice }) {
  const t = useTranslations();
  const status = invoice.status || 'pending';
  const config = statusConfig[status] || statusConfig.pending;
  const IconComponent = config.icon;

  return (
    <div className="flex items-center gap-4 p-4 bg-background border border-border rounded-lg hover:border-border transition-colors group">
      <div className={cn("p-2 rounded-lg", config.bg)}>
        <IconComponent className={cn("h-5 w-5", config.color)} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">
            #{invoice.invoiceNumber}
          </span>
          <span className={cn(
            "text-xs px-2 py-0.5 rounded-full capitalize",
            config.bg,
            config.color
          )}>
            {status}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
          <span>{t('sweep.weldcrm.invoicesSection.createdOn', { date: formatDate(invoice.createdAt) })}</span>
          {invoice.dueDate && (
            <>
              <span>·</span>
              <span className={cn(
                status === 'overdue' && 'text-red-600'
              )}>
                {t('sweep.weldcrm.invoicesSection.dueOn', { date: formatDate(invoice.dueDate) })}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="text-right">
        <p className="font-medium text-foreground">
          {formatCurrency(invoice.amount, invoice.currency)}
        </p>
        {invoice.paidAt && (
          <p className="text-xs text-green-600">
            {t('sweep.weldcrm.invoicesSection.paidOn', { date: formatDate(invoice.paidAt) })}
          </p>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem>{t('sweep.weldcrm.invoicesSection.viewInvoice')}</DropdownMenuItem>
          <DropdownMenuItem>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            {t('sweep.weldcrm.invoicesSection.downloadPdf')}
          </DropdownMenuItem>
          {status !== 'paid' && (
            <>
              <DropdownMenuItem>
                <Send className="h-3.5 w-3.5 mr-1.5" />
                {t('sweep.weldcrm.invoicesSection.sendReminder')}
              </DropdownMenuItem>
              <DropdownMenuItem>{t('sweep.weldcrm.invoicesSection.markAsPaid')}</DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem className="text-red-600">{t('sweep.weldcrm.invoicesSection.voidInvoice')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
