import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { SetupValues } from './setup-step';
import type { BuiltItems, ReviewVendor } from './new-run-model';

interface ReviewStepProps {
  values: SetupValues;
  bankAccountName: string;
  vendors: readonly ReviewVendor[];
  built: BuiltItems;
  canCreate: boolean;
  busy: boolean;
  onBack: () => void;
  /** `submit` also sends the new run for approval. */
  onCreate: (submit: boolean) => void;
}

/** Step 3: what the run will be, with the holds it will start with, before it is created. */
export function ReviewStep({ values, bankAccountName, vendors, built, canCreate, busy, onBack, onCreate }: Readonly<ReviewStepProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tr = tp.wizard.review;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const warned = vendors.filter((vendor) => vendor.warnings.length > 0);
  const hasWithholding = vendors.some((vendor) => vendor.withholding !== null);

  const secCode = values.secCode === 'auto' ? tp.secCodes.auto : tp.secCodes[values.secCode];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tr.title}</CardTitle>
        <CardDescription>{tr.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">{tr.bankAccount}</dt>
            <dd className="font-medium">{bankAccountName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{tr.method}</dt>
            <dd className="flex flex-wrap items-center gap-1 font-medium">
              {tp.methods[values.method]}
              {values.method === 'ach' && values.sameDay ? <Badge variant="secondary">{tp.sameDay}</Badge> : null}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{tr.paymentDate}</dt>
            <dd className="font-medium">{formatDate(values.paymentDate)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{tr.approvals}</dt>
            <dd className="font-medium">{values.requiredApprovals === 2 ? tr.approvalsTwo : tr.approvalsOne}</dd>
          </div>
          {values.method === 'ach' ? (
            <div>
              <dt className="text-muted-foreground">{tr.secCode}</dt>
              <dd className="font-medium">{secCode}</dd>
            </div>
          ) : null}
        </dl>

        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr.columns.vendor}</TableHead>
                <TableHead className="text-right">{tr.columns.bills}</TableHead>
                <TableHead className="text-right">{hasWithholding ? tr.columns.gross : tr.columns.amount}</TableHead>
                {hasWithholding ? <TableHead className="text-right">{tr.columns.withheld}</TableHead> : null}
                {hasWithholding ? <TableHead className="text-right">{tr.columns.net}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.map((vendor) => (
                <TableRow key={vendor.partyId}>
                  <TableCell>
                    <span className="font-medium">{vendor.name}</span>
                    {vendor.warnings.map((warning) => (
                      <Badge key={warning} variant="warning" className="ml-2">
                        {tp.wizard.bills.warnings[warning]}
                      </Badge>
                    ))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{vendor.billCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(vendor.amount)}</TableCell>
                  {hasWithholding ? (
                    <TableCell className="text-right tabular-nums">
                      {vendor.withholding ? `-${formatMoney(vendor.withholding.withheld)}` : '—'}
                    </TableCell>
                  ) : null}
                  {hasWithholding ? <TableCell className="text-right tabular-nums">{formatMoney(vendor.net)}</TableCell> : null}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-medium">
                  {tr.vendorsCount.replace('{count}', String(built.vendorCount))}
                </TableCell>
                <TableCell className="text-right tabular-nums">{built.items.length}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatMoney(built.total)}</TableCell>
                {hasWithholding ? (
                  <TableCell className="text-right font-semibold tabular-nums">-{formatMoney(built.withheld)}</TableCell>
                ) : null}
                {hasWithholding ? (
                  <TableCell className="text-right font-semibold tabular-nums">{formatMoney(built.net)}</TableCell>
                ) : null}
              </TableRow>
            </TableFooter>
          </Table>
        </div>

        {hasWithholding ? (
          <Alert>
            <AlertTitle>{tr.withholdingTitle}</AlertTitle>
            <AlertDescription>{tr.withholdingDescription}</AlertDescription>
          </Alert>
        ) : null}

        {warned.length > 0 ? (
          <Alert>
            <AlertTitle>{tr.holdsTitle}</AlertTitle>
            <AlertDescription>
              <p>{tr.holdsDescription}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {warned.map((vendor) => (
                  <li key={vendor.partyId}>
                    {vendor.name}: {vendor.warnings.map((w) => tp.wizard.bills.warnings[w]).join(', ')}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {!canCreate ? <p className="text-sm text-muted-foreground">{tr.noPermission}</p> : null}

        <div className="flex flex-wrap justify-between gap-2">
          <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
            {tp.common.back}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => onCreate(false)} disabled={!canCreate || busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {tr.createDraft}
            </Button>
            <Button type="button" onClick={() => onCreate(true)} disabled={!canCreate || busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {tr.createAndSubmit}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
