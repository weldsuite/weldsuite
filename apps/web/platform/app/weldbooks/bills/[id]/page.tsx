import { useState } from 'react';
import { Link, useParams, useNavigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import {
  useAccountingBill,
  useApproveBill,
  useRejectBill,
} from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Separator } from '@weldsuite/ui/components/separator';
import { Input } from '@weldsuite/ui/components/input';
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

const formatCurrency = (value: string | number | null) =>
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(
    Number(value ?? 0),
  );

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
  const { t } = useI18n();
  const st = useTranslations();
  const tb = t.accounting.billDetail;

  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  if (isLoading) return <PageLoader fullScreen={false} />;

  const bill = data?.data;
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

  const handleApprove = () => {
    approveBill.mutate(id, {
      onSuccess: () => {
        navigate({ to: `/weldbooks/bills/${id}` as any });
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
            <Link to={`/weldbooks/bills/${id}/edit` as any}>
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {tb.supplier}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium">{bill.contactName ?? '-'}</p>
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
              {bill.issueDate?.split('T')[0]}
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">{tb.due} </span>
              {bill.dueDate?.split('T')[0]}
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
                items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.description}</TableCell>
                    <TableCell className="text-right">{item.quantity ?? '-'}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(item.unitPrice)}
                    </TableCell>
                    <TableCell className="text-right">
                      {item.discountPercent ? `${item.discountPercent}%` : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(item.taxAmount)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(item.lineTotalWithTax ?? item.lineTotal)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <Separator className="my-4" />

          <div className="flex justify-end">
            <div className="w-64 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{tb.subtotal}</span>
                <span>{formatCurrency(bill.subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{tb.tax}</span>
                <span>{formatCurrency(bill.taxTotal)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>{tb.total}</span>
                <span>{formatCurrency(bill.total)}</span>
              </div>
              {bill.amountPaid && Number(bill.amountPaid) > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{tb.paid}</span>
                    <span>{formatCurrency(bill.amountPaid)}</span>
                  </div>
                  <div className="flex justify-between font-semibold text-destructive">
                    <span>{tb.balanceDue}</span>
                    <span>{formatCurrency(bill.balanceDue)}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

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
