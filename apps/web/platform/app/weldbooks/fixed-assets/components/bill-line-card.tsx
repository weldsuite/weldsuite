import { Link } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import { useAccountingAccounts, useAccountingBill } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../text';

interface BillLineCardProps {
  billItemId: string;
  /** When the bill is known the line is shown; without it the server reads the line by its id. */
  billId?: string;
  reclass: boolean;
  onReclassChange: (value: boolean) => void;
}

const isFixedAssetAccount = (account: { type: string; subtype: string | null } | undefined): boolean =>
  Boolean(account && account.type === 'asset' && (account.subtype === 'fixed_asset' || account.subtype === 'fixed_assets'));

/**
 * What the asset is created from: the bill line (when the bill is known), and
 * the choice to move its cost to the fixed asset account when the bill booked
 * it as an expense. The reclass has to be chosen now: it cannot be added once
 * the asset exists.
 */
export function BillLineCard({ billItemId, billId, reclass, onReclassChange }: Readonly<BillLineCardProps>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fixedAssets.form.fromBill;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const bill = useAccountingBill(billId ?? '');
  const accounts = useAccountingAccounts();
  const detail = bill.data?.data;
  const line = detail?.items.find((item) => item.id === billItemId);
  const account = line?.accountId ? accounts.data?.data.find((item) => item.id === line.accountId) : undefined;
  const capitalized = isFixedAssetAccount(account);

  return (
    <Card data-testid="bill-line-card">
      <CardHeader>
        <CardTitle className="text-base">{tf.line}</CardTitle>
        <CardDescription>{tf.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {line && detail ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t.weldbooksUs.assets.fixedAssets.form.fields.description}</dt>
              <dd className="font-medium">{line.description}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tf.lineAmount}</dt>
              <dd className="font-medium tabular-nums">{formatMoney(line.lineTotalWithTax ?? line.lineTotal, detail.currency)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t.weldbooksUs.assets.fixedAssets.form.fields.acquisitionDate}</dt>
              <dd>{formatDate(detail.issueDate)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tf.linkedBill}</dt>
              <dd>
                <Link to="/weldbooks/bills/$id" params={{ id: detail.id }} className="underline-offset-2 hover:underline">
                  {detail.billNumber ?? detail.id}
                </Link>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {tf.costOverrideHelp}
          </p>
        )}

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id="asset-reclass"
              checked={reclass && !capitalized}
              disabled={capitalized}
              onCheckedChange={(checked) => onReclassChange(checked === true)}
            />
            <Label htmlFor="asset-reclass" className="font-normal">
              {tf.reclassTitle}
            </Label>
          </div>
          <p className="pl-6 text-xs text-muted-foreground">
            {capitalized
              ? tf.alreadyCapitalized
              : account
                ? `${fill(tf.expenseBooked, { account: `${account.code} — ${account.name}` })} ${tf.reclassHelp}`
                : tf.reclassHelp}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
