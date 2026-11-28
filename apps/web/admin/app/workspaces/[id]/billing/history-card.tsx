'use client';

import { ExternalLink, FileText } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { adminCopy } from '@/lib/i18n';
import { formatCents, formatDay } from '@/lib/billing-format';
import type { InvoiceRow, PaymentRow } from '@/lib/billing-types';
import { mollieBillingCopy } from '@/lib/mollie-billing-copy';
import { isAbsoluteUrl, isStripeRow, paymentKindLabel } from '@/lib/mollie-billing';

const INVOICE_TONE: Record<string, 'success' | 'warning' | 'secondary' | 'destructive'> = {
  paid: 'success',
  open: 'warning',
  draft: 'secondary',
  void: 'secondary',
  uncollectible: 'destructive',
};

const PAYMENT_TONE: Record<string, 'success' | 'warning' | 'secondary' | 'destructive'> = {
  succeeded: 'success',
  processing: 'warning',
  requires_action: 'warning',
  failed: 'destructive',
  canceled: 'secondary',
};

/**
 * A workspace's invoices and payments. Read-only: refunds run from the CLI.
 * Stripe rows (from before Global moved into this install) keep their links.
 */
export function HistoryCard({ invoices, payments }: Readonly<{ invoices: InvoiceRow[]; payments: PaymentRow[] }>) {
  const t = adminCopy();

  return (
    <Card className="py-4">
      <CardContent className="space-y-6 px-4">
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{t.invoices.title}</h2>
          </div>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.invoices.empty}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.invoices.columns.number}</TableHead>
                    <TableHead className="w-32">{t.invoices.columns.date}</TableHead>
                    <TableHead className="w-28">{t.invoices.columns.status}</TableHead>
                    <TableHead className="w-28 text-right">{t.invoices.columns.due}</TableHead>
                    <TableHead className="w-28 text-right">{t.invoices.columns.paid}</TableHead>
                    <TableHead className="w-48">{t.invoices.columns.links}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell className="font-mono text-xs">{invoice.number ?? '—'}</TableCell>
                      <TableCell className="text-xs tabular-nums">{formatDay(invoice.createdAt)}</TableCell>
                      <TableCell>
                        <Badge variant={INVOICE_TONE[invoice.status ?? ''] ?? 'secondary'}>{invoice.status ?? '—'}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCents(invoice.amountDue, invoice.currency)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCents(invoice.amountPaid, invoice.currency)}</TableCell>
                      {isStripeRow(invoice) ? (
                        <TableCell className="space-x-3 text-xs">
                          {invoice.pdfUrl && <ExternalAnchor href={invoice.pdfUrl}>{t.invoices.pdf}</ExternalAnchor>}
                          {invoice.hostedUrl && <ExternalAnchor href={invoice.hostedUrl}>{t.invoices.payLink}</ExternalAnchor>}
                        </TableCell>
                      ) : (
                        <ProviderInvoiceCell invoice={invoice} />
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">{t.payments.title}</h2>
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.payments.empty}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">{t.payments.columns.date}</TableHead>
                    <TableHead className="w-28 text-right">{t.payments.columns.amount}</TableHead>
                    <TableHead className="w-28">{t.payments.columns.status}</TableHead>
                    <TableHead>{t.payments.columns.method}</TableHead>
                    <TableHead className="w-28 text-right">{t.payments.columns.refunded}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((payment) => (
                    <TableRow key={payment.id}>
                      <TableCell className="text-xs tabular-nums">{formatDay(payment.createdAt)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCents(payment.amount, payment.currency)}</TableCell>
                      <TableCell>
                        <Badge variant={PAYMENT_TONE[payment.status] ?? 'secondary'}>{payment.status}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {[payment.methodBrand ?? payment.methodType, payment.methodLast4 && `•••• ${payment.methodLast4}`]
                          .filter(Boolean)
                          .join(' ') || '—'}
                        {!isStripeRow(payment) && <ProviderPaymentReference payment={payment} />}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {payment.refundedAmount > 0 ? formatCents(payment.refundedAmount, payment.currency) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {payments.some((payment) => !isStripeRow(payment)) && (
            <p className="text-xs text-muted-foreground">{mollieBillingCopy().history.refundHint}</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * The links cell of an invoice Stripe doesn't hold (a WeldBooks invoice on the
 * EU edition): the Mollie payment it was issued for, and only links that open
 * from here (its `pdf_url` is a platform API path behind the customer's session).
 */
function ProviderInvoiceCell({ invoice }: Readonly<{ invoice: InvoiceRow }>) {
  const t = adminCopy();
  const c = mollieBillingCopy();
  return (
    <TableCell className="text-xs">
      <div className="text-muted-foreground">
        {invoice.provider === 'weldbooks' ? c.history.weldbooks : invoice.provider}
        {invoice.providerPaymentId && (
          <>
            {' · '}
            {c.history.mollie} <span className="font-mono">{invoice.providerPaymentId}</span>
          </>
        )}
      </div>
      {(isAbsoluteUrl(invoice.pdfUrl) || isAbsoluteUrl(invoice.hostedUrl)) && (
        <div className="space-x-3">
          {isAbsoluteUrl(invoice.pdfUrl) && <ExternalAnchor href={invoice.pdfUrl}>{t.invoices.pdf}</ExternalAnchor>}
          {isAbsoluteUrl(invoice.hostedUrl) && <ExternalAnchor href={invoice.hostedUrl}>{t.invoices.payLink}</ExternalAnchor>}
        </div>
      )}
    </TableCell>
  );
}

/** Under the method of a charge Stripe doesn't hold: what it was for and its Mollie payment id. */
function ProviderPaymentReference({ payment }: Readonly<{ payment: PaymentRow }>) {
  const c = mollieBillingCopy();
  const kind = paymentKindLabel(c, payment.kind);
  return (
    <div className="mt-0.5">
      {[payment.provider === 'mollie' ? c.history.mollie : payment.provider, kind].filter(Boolean).join(' · ')}
      {payment.providerPaymentId && <span className="ml-1 font-mono">{payment.providerPaymentId}</span>}
    </div>
  );
}

function ExternalAnchor({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}
