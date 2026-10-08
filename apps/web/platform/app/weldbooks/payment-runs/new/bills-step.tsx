import { Link } from '@tanstack/react-router';
import { AlertTriangle, Ban } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { PayableVendor, RunMethod } from '@/lib/api/domains/weldbooks-payment-runs';
import {
  amountProblem,
  blockOf,
  setAmount,
  setPicked,
  setVendorPicked,
  vendorBlock,
  vendorWarnings,
  type BuiltItems,
  type PickMap,
} from './new-run-model';

interface BillsStepProps {
  vendors: readonly PayableVendor[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  method: RunMethod;
  picks: PickMap;
  onPicksChange: (picks: PickMap) => void;
  requirePrenotes: boolean;
  built: BuiltItems;
  onBack: () => void;
  onNext: () => void;
}

/** Step 2: the bills to pay, by vendor, with the amount to pay on each. */
export function BillsStep({
  vendors,
  loading,
  failed,
  onRetry,
  method,
  picks,
  onPicksChange,
  requirePrenotes,
  built,
  onBack,
  onNext,
}: Readonly<BillsStepProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tb = tp.wizard.bills;
  const { formatMoney, formatDate } = useWeldbooksFormat();

  let body: React.ReactNode;
  if (loading) {
    body = <PageLoader fullScreen={false} />;
  } else if (failed) {
    body = (
      <div className="space-y-2">
        <p className="text-sm text-destructive" role="alert">{tp.common.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>{tp.common.retry}</Button>
      </div>
    );
  } else if (vendors.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-1 py-10 text-center">
          <p className="font-medium">{tb.emptyTitle}</p>
          <p className="text-sm text-muted-foreground">{tb.emptyDescription}</p>
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <div className="space-y-3">
        {vendors.map((vendor) => {
          const block = vendorBlock(vendor, method);
          const warnings = vendorWarnings(vendor, method, { requirePrenotes });
          const selectable = vendor.bills.filter((bill) => !blockOf(vendor, bill, method));
          const pickedCount = selectable.filter((bill) => picks[bill.id]?.selected).length;
          const preview = built.byVendor[vendor.partyId];
          const allPicked = selectable.length > 0 && pickedCount === selectable.length;
          const vendorChecked: boolean | 'indeterminate' = allPicked ? true : pickedCount > 0 ? 'indeterminate' : false;

          return (
            <Card key={vendor.partyId} data-testid={`vendor-${vendor.partyId}`}>
              <CardHeader className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Checkbox
                    aria-label={tb.selectVendor.replace('{vendor}', vendor.name)}
                    checked={vendorChecked}
                    disabled={selectable.length === 0}
                    onCheckedChange={(checked) => onPicksChange(setVendorPicked(picks, vendor, method, checked === true))}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{vendor.name}</p>
                    {method === 'ach' && vendor.ach?.last4 ? (
                      <p className="text-xs text-muted-foreground">
                        {tb.achAccount
                          .replace('{type}', vendor.ach.accountType ? tp.accountTypes[vendor.ach.accountType] : '')
                          .replace('{last4}', vendor.ach.last4)}
                      </p>
                    ) : null}
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {tb.totalDue.replace('{amount}', formatMoney(vendor.totalDue))}
                  </span>
                  {vendor.backupWithholding.applies ? (
                    <Badge variant="secondary">
                      {tb.withholdingBadge.replace('{rate}', String(Math.round(vendor.backupWithholding.rate * 100)))}
                    </Badge>
                  ) : null}
                  {warnings.map((warning) => (
                    <Badge key={warning} variant="warning">{tb.warnings[warning]}</Badge>
                  ))}
                  {block && block !== 'in_open_run' ? (
                    <Badge variant="destructive">
                      <Ban aria-hidden />
                      {tb.blocks[block]}
                    </Badge>
                  ) : null}
                </div>

                {block && block !== 'in_open_run' ? (
                  <p className="flex items-start gap-2 text-sm text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>
                      {tb.blockHelp[block]}{' '}
                      <Link to="/weldbooks/suppliers" className="font-medium underline underline-offset-2">
                        {tb.openVendors}
                      </Link>
                    </span>
                  </p>
                ) : null}
                {vendor.backupWithholding.applies ? (
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <p>
                      {tb.withholdingHelp
                        .replace('{rate}', String(Math.round(vendor.backupWithholding.rate * 100)))
                        .replace('{reason}', vendor.backupWithholding.reason ? tb.withholdingReasons[vendor.backupWithholding.reason] : tb.withholdingReasons.other)}
                    </p>
                    {preview ? (
                      <p className="font-medium text-foreground">
                        {tb.withholdingPreview
                          .replace('{gross}', formatMoney(preview.grossCents / 100))
                          .replace('{withheld}', formatMoney(preview.withholding?.withheld ?? 0))
                          .replace('{net}', formatMoney(preview.withholding?.net ?? preview.grossCents / 100))}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {warnings.includes('prenote_needed') || warnings.includes('prenote_pending') ? (
                  <p className="text-sm text-muted-foreground">{tb.prenoteHelp}</p>
                ) : null}
              </CardHeader>

              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead>{tb.columns.bill}</TableHead>
                      <TableHead>{tb.columns.due}</TableHead>
                      <TableHead className="text-right">{tb.columns.balance}</TableHead>
                      <TableHead className="w-40 text-right">{tb.columns.pay}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vendor.bills.map((bill) => {
                      const pick = picks[bill.id];
                      const billBlocked = blockOf(vendor, bill, method);
                      const label = bill.billNumber ?? bill.reference ?? bill.id;
                      const problem = pick?.selected && !billBlocked ? amountProblem(bill, pick.amount) : null;
                      return (
                        <TableRow key={bill.id} className={billBlocked ? 'opacity-60' : undefined}>
                          <TableCell>
                            <Checkbox
                              aria-label={tb.selectBill.replace('{bill}', label)}
                              checked={!!pick?.selected && !billBlocked}
                              disabled={!!billBlocked}
                              onCheckedChange={(checked) => onPicksChange(setPicked(picks, bill.id, checked === true))}
                            />
                          </TableCell>
                          <TableCell>
                            <span className="font-medium">{label}</span>
                            {bill.inOpenRunId ? (
                              <Badge variant="warning" className="ml-2">
                                <Link to="/weldbooks/payment-runs/$id" params={{ id: bill.inOpenRunId }} className="underline underline-offset-2">
                                  {tb.blocks.in_open_run}
                                </Link>
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatDate(bill.dueDate)}
                            {bill.daysOverdue > 0 ? (
                              <Badge variant="destructive" className="ml-2">
                                {tb.overdue.replace('{days}', String(bill.daysOverdue))}
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(bill.balanceDue ?? '0')}</TableCell>
                          <TableCell className="text-right">
                            <Input
                              aria-label={tb.amountFor.replace('{bill}', label)}
                              aria-invalid={!!problem}
                              inputMode="decimal"
                              className="ml-auto w-32 text-right tabular-nums"
                              value={pick?.amount ?? ''}
                              disabled={!!billBlocked}
                              onChange={(e) => onPicksChange(setAmount(picks, bill.id, e.target.value))}
                            />
                            {problem ? (
                              <p className="mt-1 text-xs text-destructive">{tb.amountProblems[problem]}</p>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {body}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background p-3">
        <p className="text-sm">
          {tb.selected.replace('{bills}', String(built.items.length)).replace('{vendors}', String(built.vendorCount))}
          {' · '}
          <span className="font-medium tabular-nums">{formatMoney(built.total)}</span>
          {built.withheld > 0 ? (
            <span className="block text-muted-foreground">
              {tb.selectedWithheld.replace('{withheld}', formatMoney(built.withheld)).replace('{net}', formatMoney(built.net))}
            </span>
          ) : null}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onBack}>{tp.common.back}</Button>
          <Button type="button" onClick={onNext} disabled={built.items.length === 0 || built.problems.length > 0}>
            {tb.review}
          </Button>
        </div>
      </div>
    </div>
  );
}
