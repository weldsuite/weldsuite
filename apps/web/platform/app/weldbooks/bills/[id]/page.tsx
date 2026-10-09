import { useState } from 'react';
import { Link, useParams, useNavigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import {
  useAccountingBill,
  useApproveBill,
  useRejectBill,
} from '@/hooks/queries/use-accounting-queries';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Separator } from '@weldsuite/ui/components/separator';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { ArrowLeft, Pencil, Check, X } from 'lucide-react';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import { countryName } from '@/components/address/countries';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { salesTaxErrorCode, type BillWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { groupTaxBreakdown } from '@/lib/weldbooks/document-tax';
import { isWeldTaxCode } from '@/lib/weldbooks/tax-codes';
import { FORM_1099_OMIT, form1099BoxName } from '@/lib/weldbooks/form-1099';
import { Link as AppLink } from '@/lib/router';
import { SalesTaxErrorNotice, useDescribeError } from '@/app/weldbooks/invoices/components/sales-tax-error-notice';
import { TaxBreakdownList } from '@/app/weldbooks/invoices/components/tax-breakdown';
import { toast } from 'sonner';

function statusVariant(status: string) {
  switch (status) {
    case 'paid':
      return 'default' as const;
    case 'approved':
      return 'secondary' as const;
    case 'overdue':
      return 'destructive' as const;
    case 'draft':
      return 'outline' as const;
    case 'cancelled':
      return 'destructive' as const;
    default:
      return 'secondary' as const;
  }
}

function approvalVariant(status: string | null) {
  switch (status) {
    case 'approved':
      return 'default' as const;
    case 'rejected':
      return 'destructive' as const;
    case 'pending':
      return 'outline' as const;
    default:
      return 'secondary' as const;
  }
}

export default function BillDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { data, isLoading } = useAccountingBill(id);
  const approveBill = useApproveBill();
  const rejectBill = useRejectBill();
  const { t, language } = useI18n();
  const st = useTranslations();
  const tb = t.accounting.billDetail;
  const td = useDocumentTexts();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { features } = useJurisdictionLabels();
  const describeError = useDescribeError();

  /** The last approval that a sales tax rule refused (the use tax engine was down, ...). */
  const [taxError, setTaxError] = useState<unknown>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [openingAttachment, setOpeningAttachment] = useState<number | null>(null);

  if (isLoading) return <PageLoader fullScreen={false} />;

  const bill = data?.data as unknown as BillWithTax | undefined;
  if (!bill) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{tb.billNotFound}</p>
        <Link to="/weldbooks/bills">
          <Button variant="link" className="mt-2">{tb.backToBills}</Button>
        </Link>
      </div>
    );
  }

  const items = bill.items ?? [];
  const vendorAddressLines = formatPostalAddressLines(normalizeAccountingAddress(bill.vendorAddress), {
    countryName: (code) => countryName(code, language),
  });

  const handleOpenAttachment = async (index: number, fallbackName: string) => {
    setOpeningAttachment(index);
    try {
      const { blob, filename } = await accountingApi.getBillAttachment(id, index);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = filename || fallbackName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Bill] attachment open failed', err);
      toast.error(tb.failedToOpenAttachment);
    } finally {
      setOpeningAttachment(null);
    }
  };

  const handleApprove = () => {
    setTaxError(null);
    approveBill.mutate(id, {
      onSuccess: () => {
        navigate({ to: '/weldbooks/bills/$id', params: { id } });
      },
      onError: (err) => {
        // Approving recalculates the use tax and refuses while the engine can't answer.
        if (salesTaxErrorCode(err)) setTaxError(err);
        else toast.error(td.bill.approveFailed, { description: describeError(err) });
      },
    });
  };

  const handleReject = () => {
    if (!rejectReason.trim()) return;
    rejectBill.mutate(
      { id, reason: rejectReason },
      {
        onSuccess: () => {
          setRejectDialogOpen(false);
          setRejectReason('');
        },
      },
    );
  };

  const isDraft = bill.status === 'draft';
  const isPosted = bill.approvalStatus === 'approved' || ['approved', 'paid', 'partial', 'overdue'].includes(bill.status);
  const taxGroups = groupTaxBreakdown(bill.taxBreakdown);
  const useTaxGroups = taxGroups.filter((group) => group.kind === 'use');
  const deliveryLines = formatPostalAddressLines(normalizeAccountingAddress(bill.deliveryAddress), {
    countryName: (code) => countryName(code, language),
  });

  /** Tax code, use tax accrual and 1099 box of a line, when they are set. */
  const lineFlags = (item: BillWithTax['items'][number]): string[] => {
    const flags: string[] = [];
    if (features.salesTax && item.taxCode) flags.push(isWeldTaxCode(item.taxCode) ? td.taxCodes[item.taxCode] : item.taxCode);
    if (item.accrueUseTax) flags.push(td.bill.accrueUseTax);
    if (features.form1099 && item.form1099Box) {
      flags.push(item.form1099Box === FORM_1099_OMIT ? td.bill.form1099Omit : form1099BoxName(item.form1099Box));
    }
    return flags;
  };
  const isPendingApproval = bill.approvalStatus === 'pending' || bill.status === 'pending_approval';

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/weldbooks/bills">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">
              {bill.billNumber ?? st('sweep.weldbooks.billDetail.billFallback')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {bill.contactName}
            </p>
          </div>
          <Badge variant={statusVariant(bill.status)}>{bill.status}</Badge>
          {bill.approvalStatus && (
            <Badge variant={approvalVariant(bill.approvalStatus)}>
              {bill.approvalStatus}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isDraft && (
            <Link to="/weldbooks/bills/$id/edit" params={{ id }}>
              <Button variant="outline" size="sm">
                <Pencil className="h-4 w-4 mr-1" />
                {tb.edit}
              </Button>
            </Link>
          )}
          {isPendingApproval && (
            <>
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={approveBill.isPending}
              >
                <Check className="h-4 w-4 mr-1" />
                {tb.approve}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setRejectDialogOpen(true)}
                disabled={rejectBill.isPending}
              >
                <X className="h-4 w-4 mr-1" />
                {tb.reject}
              </Button>
            </>
          )}
        </div>
      </div>

      {taxError !== null && <SalesTaxErrorNotice error={taxError} />}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {tb.supplier}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium">{bill.contactName ?? '-'}</p>
            {vendorAddressLines.map((line, index) => (
              <p key={`${index}-${line}`} className="text-sm text-muted-foreground">
                {line}
              </p>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {tb.dates}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-sm">
              <span className="text-muted-foreground">{tb.issued} </span>
              {formatDate(bill.issueDate)}
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">{tb.due} </span>
              {formatDate(bill.dueDate)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {tb.reference}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium">{bill.externalReference || '-'}</p>
          </CardContent>
        </Card>
      </div>

      {features.salesTax && deliveryLines.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{td.bill.deliveryTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {deliveryLines.map((line, index) => (
              <p key={`${index}-${line}`} className="text-sm">
                {line}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {bill.attachmentKeys && bill.attachmentKeys.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{tb.originalDocuments}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {bill.attachmentKeys.map((key, index) => {
              const name = key.split('/').pop() || tb.attachmentFallback.replace('{n}', String(index + 1));
              return (
                <Button
                  key={`${key}-${index}`}
                  variant="outline"
                  size="sm"
                  disabled={openingAttachment === index}
                  onClick={() => handleOpenAttachment(index, name)}
                >
                  {openingAttachment === index ? '…' : `${tb.openAttachment}: ${name}`}
                </Button>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{tb.lineItems}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tb.description}</TableHead>
                <TableHead className="text-right">{tb.qty}</TableHead>
                <TableHead className="text-right">{tb.unitPrice}</TableHead>
                <TableHead className="text-right">{tb.discountPercent}</TableHead>
                <TableHead className="text-right">{tb.tax}</TableHead>
                <TableHead className="text-right">{tb.lineTotal}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {tb.noLineItems}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => {
                  const flags = lineFlags(item);
                  return (
                  <TableRow key={item.id}>
                    <TableCell>
                      {item.description}
                      {flags.length > 0 && <span className="block text-xs text-muted-foreground">{flags.join(' · ')}</span>}
                      {features.salesTax && isPosted && (
                        <AppLink
                          href={`/weldbooks/fixed-assets/new?billItemId=${encodeURIComponent(item.id)}`}
                          className="block text-xs font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {td.bill.createFixedAsset}
                        </AppLink>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{item.quantity ?? '-'}</TableCell>
                    <TableCell className="text-right">
                      {formatMoney(item.unitPrice, bill.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {item.discountPercent ? `${item.discountPercent}%` : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(item.taxAmount, bill.currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatMoney(item.lineTotalWithTax ?? item.lineTotal, bill.currency)}
                    </TableCell>
                  </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>

          <Separator className="my-4" />

          <div className="flex justify-end">
            <div className="w-64 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{tb.subtotal}</span>
                <span>{formatMoney(bill.subtotal, bill.currency)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{features.salesTax ? td.bill.vendorTaxLabel : tb.tax}</span>
                <span>{formatMoney(bill.taxTotal, bill.currency)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>{tb.total}</span>
                <span>{formatMoney(bill.total, bill.currency)}</span>
              </div>
              {bill.amountPaid && Number(bill.amountPaid) > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{tb.paid}</span>
                    <span>{formatMoney(bill.amountPaid, bill.currency)}</span>
                  </div>
                  <div className="flex justify-between font-semibold text-destructive">
                    <span>{tb.balanceDue}</span>
                    <span>{formatMoney(bill.balanceDue, bill.currency)}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {features.salesTax && useTaxGroups.length > 0 && (
        <Card data-testid="use-tax-card">
          <CardHeader>
            <CardTitle>{td.bill.useTaxTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <TaxBreakdownList groups={useTaxGroups} currency={bill.currency} taxLabel={td.bill.useTaxTitle} plain />
            <p className="text-xs text-muted-foreground">{td.bill.useTaxNote}</p>
          </CardContent>
        </Card>
      )}

      {(bill.notes || bill.internalNotes) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {bill.notes && (
            <Card>
              <CardHeader>
                <CardTitle>{tb.notes}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{bill.notes}</p>
              </CardContent>
            </Card>
          )}
          {bill.internalNotes && (
            <Card>
              <CardHeader>
                <CardTitle>{tb.internalNotes}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{bill.internalNotes}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tb.rejectBillTitle}</DialogTitle>
            <DialogDescription>
              {tb.rejectBillDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rejectReason">{tb.rejectReason}</Label>
            <Textarea
              id="rejectReason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              placeholder={tb.rejectReasonPlaceholder}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              {tb.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={!rejectReason.trim() || rejectBill.isPending}
            >
              {rejectBill.isPending ? tb.rejecting : tb.rejectConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
