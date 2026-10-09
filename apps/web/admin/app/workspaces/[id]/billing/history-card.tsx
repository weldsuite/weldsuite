'use client';

import { useState } from 'react';
import { ExternalLink, FileText } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { refundPayment, voidInvoice } from '@/actions/billing';
import { adminCopy, fill } from '@/lib/i18n';
import { formatCents, formatDay } from '@/lib/billing-format';
import type { InvoiceRow, PaymentRow } from '@/lib/billing-types';

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

export function HistoryCard({
  workspaceId,
  invoices,
  payments,
  canWrite,
}: Readonly<{ workspaceId: string; invoices: InvoiceRow[]; payments: PaymentRow[]; canWrite: boolean }>) {
  const t = adminCopy();
  const [voiding, setVoiding] = useState<InvoiceRow | null>(null);
  const [refunding, setRefunding] = useState<PaymentRow | null>(null);

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
                    {canWrite && <TableHead className="w-20" />}
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
                      <TableCell className="space-x-3 text-xs">
                        {invoice.pdfUrl && <ExternalAnchor href={invoice.pdfUrl}>{t.invoices.pdf}</ExternalAnchor>}
                        {invoice.hostedUrl && <ExternalAnchor href={invoice.hostedUrl}>{t.invoices.payLink}</ExternalAnchor>}
                      </TableCell>
                      {canWrite && (
                        <TableCell className="text-right">
                          {invoice.status === 'open' && (
                            <Button size="sm" variant="ghost" onClick={() => setVoiding(invoice)}>
                              {t.invoices.void}
                            </Button>
                          )}
                        </TableCell>
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
                    {canWrite && <TableHead className="w-24" />}
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
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {payment.refundedAmount > 0 ? formatCents(payment.refundedAmount, payment.currency) : '—'}
                      </TableCell>
                      {canWrite && (
                        <TableCell className="text-right">
                          {payment.status === 'succeeded' && payment.refundedAmount < payment.amount && (
                            <Button size="sm" variant="ghost" onClick={() => setRefunding(payment)}>
                              {t.payments.refund}
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </CardContent>

      {voiding && (
        <ActionDialog
          destructive
          title={fill(t.invoices.voidTitle, { number: voiding.number ?? voiding.id })}
          description={t.invoices.voidDescription}
          submitLabel={t.invoices.voidSubmit}
          successMessage={t.invoices.voidSuccess}
          onClose={() => setVoiding(null)}
          onSubmit={(reason, requestId) => voidInvoice(workspaceId, voiding.id, { reason }, requestId)}
        />
      )}
      {refunding && <RefundDialog workspaceId={workspaceId} payment={refunding} onClose={() => setRefunding(null)} />}
    </Card>
  );
}

function RefundDialog({
  workspaceId,
  payment,
  onClose,
}: Readonly<{ workspaceId: string; payment: PaymentRow; onClose: () => void }>) {
  const t = adminCopy();
  const refundableCents = payment.amount - payment.refundedAmount;
  const [value, setValue] = useState((refundableCents / 100).toFixed(2));
  const cents = /^\d+([.,]\d{1,2})?$/.test(value.trim())
    ? Math.round(Number.parseFloat(value.trim().replace(',', '.')) * 100)
    : null;
  const valid = cents !== null && cents >= 1 && cents <= refundableCents;

  return (
    <ActionDialog
      destructive
      title={t.payments.refundTitle}
      description={fill(t.payments.refundDescription, {
        amount: formatCents(payment.amount, payment.currency),
        date: formatDay(payment.createdAt),
      })}
      submitLabel={t.payments.refundSubmit}
      invalidMessage={valid ? null : t.payments.refundInvalid}
      onClose={onClose}
      onSubmit={(reason, requestId) =>
        refundPayment(
          workspaceId,
          payment.id,
          { ...(cents === refundableCents ? {} : { amountCents: cents ?? undefined }), reason },
          requestId,
        )
      }
      successMessage={(data) => fill(t.payments.refundSuccess, { amount: formatCents(data.amountCents, data.currency) })}
    >
      <Field
        label={fill(t.payments.refundAmount, { currency: payment.currency.toUpperCase() })}
        htmlFor="refund-amount"
        hint={fill(t.payments.refundable, { amount: formatCents(refundableCents, payment.currency) })}
      >
        <Input id="refund-amount" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <p className="text-xs text-muted-foreground">{t.payments.creditTopupNote}</p>
    </ActionDialog>
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
