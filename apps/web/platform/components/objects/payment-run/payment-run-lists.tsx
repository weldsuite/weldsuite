/**
 * The list tabs of the payment run panel: the vendors a run pays, the bills
 * behind the amounts, and the vendors it holds back.
 *
 * Rows are `TabListRow`s, so they fit the 480px side panel: the secondary
 * columns (bill counts, due dates, balances) drop out below 560px of list
 * width and are there in fullscreen.
 */

import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { CheckStatusBadge } from '@/app/weldbooks/payment-runs/components/run-badges';
import { ReasonDialog } from '@/app/weldbooks/payment-runs/components/reason-dialog';
import { holdFixTarget, isUnreleasableHold } from '@/app/weldbooks/payment-runs/payment-run-utils';
import type {
  PaymentRunDetail,
  RunHoldView,
  RunItemView,
  RunVendorView,
} from '@/lib/api/domains/weldbooks-payment-runs';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const LIST_BORDER = 'border-t border-gray-200/70 dark:border-border';
const HEADER_ROW =
  'hidden items-center gap-4 border-b border-gray-200/70 px-4 py-2 text-xs text-muted-foreground dark:border-border @min-[560px]:flex';

// ─── Vendors ───────────────────────────────────────────────────────────────

/** What became of a vendor's payment: made, voided, a check and its status, not paid yet. */
function VendorPaymentStatus({ vendor, method }: Readonly<{ vendor: RunVendorView; method: PaymentRunDetail['method'] }>) {
  const { t } = useI18n();
  const tv = t.weldbooksUs.payments.detail.vendors;
  const { payment } = vendor;

  if (!payment) {
    return vendor.held ? null : <span className="text-sm text-muted-foreground">{tv.notPaidYet}</span>;
  }
  if (method === 'check' && payment.checkNumber) {
    return (
      <>
        <span className="text-sm tabular-nums">{tv.checkNumber.replace('{number}', payment.checkNumber)}</span>
        {payment.checkStatus ? <CheckStatusBadge status={payment.checkStatus} /> : null}
      </>
    );
  }
  return (
    <Badge variant={payment.deleted ? 'outline' : 'success'}>
      {payment.deleted ? tv.paymentVoided : tv.paymentMade}
    </Badge>
  );
}

function VendorRow({ vendor, method }: Readonly<{ vendor: RunVendorView; method: PaymentRunDetail['method'] }>) {
  const { t } = useI18n();
  const tv = t.weldbooksUs.payments.detail.vendors;
  const { formatMoney } = useWeldbooksFormat();
  const withholding = vendor.backupWithholding;

  return (
    <TabListRow label={vendor.name}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="truncate text-sm font-medium">{vendor.name}</div>
        <div className="flex flex-wrap items-center gap-2">
          {vendor.held ? <Badge variant="warning">{tv.held}</Badge> : null}
          <VendorPaymentStatus vendor={vendor} method={method} />
        </div>
        {withholding ? (
          <p className="text-xs text-muted-foreground">
            {tv.withholdingLine
              .replace('{rate}', String(Math.round(withholding.rate * 100)))
              .replace('{withheld}', formatMoney(withholding.amount))
              .replace('{net}', formatMoney(withholding.net))}
          </p>
        ) : null}
      </div>
      <span className="w-[56px] flex-shrink-0 text-right text-sm tabular-nums @max-[559px]:hidden">
        {vendor.billCount}
      </span>
      <span className="w-[104px] flex-shrink-0 text-right text-sm font-medium tabular-nums">
        {formatMoney(vendor.amount)}
      </span>
    </TabListRow>
  );
}

/** The vendors a run pays, what each gets and what became of it. */
export function PaymentRunVendorsTab({ run }: Readonly<{ run: PaymentRunDetail }>) {
  const { t } = useI18n();
  const tv = t.weldbooksUs.payments.detail.vendors;

  return (
    <TabListScope>
      <div className={HEADER_ROW}>
        <span className="min-w-0 flex-1">{tv.columns.vendor}</span>
        <span className="w-[56px] flex-shrink-0 text-right">{tv.columns.bills}</span>
        <span className="w-[104px] flex-shrink-0 text-right">{tv.columns.amount}</span>
        <span className="w-[40px] flex-shrink-0" />
      </div>
      <div className={LIST_BORDER}>
        {run.vendors.map((vendor) => (
          <VendorRow key={vendor.partyId} vendor={vendor} method={run.method} />
        ))}
      </div>
    </TabListScope>
  );
}

// ─── Bills ─────────────────────────────────────────────────────────────────

function BillRow({ item }: Readonly<{ item: RunItemView }>) {
  const { t } = useI18n();
  const tv = t.weldbooksUs.payments.detail.vendors;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const due = item.dueDate ? formatDate(item.dueDate) : null;

  return (
    <TabListRow label={item.billNumber ?? item.billId}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.billNumber ?? item.billId}</div>
        <div className="truncate text-xs text-muted-foreground">{item.partyName}</div>
        {due ? (
          <div className="truncate text-xs text-muted-foreground @min-[560px]:hidden">
            {tv.columns.due} <span className="tabular-nums text-foreground">{due}</span>
          </div>
        ) : null}
      </div>
      <span
        className={cn(
          'w-[110px] flex-shrink-0 whitespace-nowrap text-right text-sm tabular-nums @max-[559px]:hidden',
          !due && 'text-muted-foreground',
        )}
      >
        {due ?? '—'}
      </span>
      <span className="w-[100px] flex-shrink-0 text-right text-sm tabular-nums @max-[559px]:hidden">
        {item.balanceDue ? formatMoney(item.balanceDue) : '—'}
      </span>
      <span className="w-[104px] flex-shrink-0 text-right text-sm font-medium tabular-nums">
        {formatMoney(item.amount)}
      </span>
    </TabListRow>
  );
}

/** The bills behind the amounts: what is due, what is left, and what the run pays. */
export function PaymentRunBillsTab({ run }: Readonly<{ run: PaymentRunDetail }>) {
  const { t } = useI18n();
  const tv = t.weldbooksUs.payments.detail.vendors;

  return (
    <TabListScope>
      <div className={HEADER_ROW}>
        <span className="min-w-0 flex-1">{tv.columns.bill}</span>
        <span className="w-[110px] flex-shrink-0 text-right">{tv.columns.due}</span>
        <span className="w-[100px] flex-shrink-0 text-right">{tv.columns.balance}</span>
        <span className="w-[104px] flex-shrink-0 text-right">{tv.columns.paying}</span>
        <span className="w-[40px] flex-shrink-0" />
      </div>
      <div className={LIST_BORDER}>
        {run.items.map((item) => (
          <BillRow key={item.billId} item={item} />
        ))}
      </div>
    </TabListScope>
  );
}

// ─── Holds ─────────────────────────────────────────────────────────────────

function HoldFix({ hold }: Readonly<{ hold: RunHoldView }>) {
  const { t } = useI18n();
  const th = t.weldbooksUs.payments.holds;
  const toChart = holdFixTarget(hold.code) === 'chart';
  return (
    <Button asChild variant="outline" size="sm">
      {toChart ? (
        <Link to="/weldbooks/accounts">{th.fixChart}</Link>
      ) : (
        <Link to="/weldbooks/suppliers">{th.fixVendor}</Link>
      )}
    </Button>
  );
}

function HoldRow({
  hold,
  nameOf,
  canRelease,
  onReleaseClick,
}: Readonly<{
  hold: RunHoldView;
  nameOf: (userId: string | null | undefined) => string;
  canRelease: boolean;
  onReleaseClick: (hold: RunHoldView) => void;
}>) {
  const { t } = useI18n();
  const th = t.weldbooksUs.payments.holds;
  const { formatDateTime } = useWeldbooksFormat();

  let action: ReactNode = null;
  if (!hold.released && canRelease) {
    action =
      isUnreleasableHold(hold.code) || !hold.releasable ? (
        <HoldFix hold={hold} />
      ) : (
        <Button variant="outline" size="sm" onClick={() => onReleaseClick(hold)}>
          {th.release}
        </Button>
      );
  }

  return (
    <TabListRow label={hold.partyName}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="truncate text-sm font-medium">{hold.partyName}</div>
        <p className="text-sm">{th.codes[hold.code]}</p>
        <p className="text-xs text-muted-foreground">{th.help[hold.code]}</p>
        {hold.released ? (
          <>
            <p className="text-xs text-muted-foreground">
              {th.releasedBy
                .replace('{name}', nameOf(hold.released.by))
                .replace('{date}', formatDateTime(hold.released.at))}
            </p>
            <p className="text-xs text-muted-foreground">{hold.released.reason}</p>
          </>
        ) : null}
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
      <span className="flex-shrink-0">
        {hold.released ? (
          <Badge variant="success">{th.released}</Badge>
        ) : (
          <Badge variant="warning">{th.active}</Badge>
        )}
      </span>
    </TabListRow>
  );
}

/** The vendors a run keeps out of its payments, why, and the way to let them in. */
export function PaymentRunHoldsTab({
  run,
  nameOf,
  canRelease,
  onRelease,
}: Readonly<{
  run: PaymentRunDetail;
  nameOf: (userId: string | null | undefined) => string;
  /** The person may release holds (`banking:manage`) and the run still can be changed. */
  canRelease: boolean;
  onRelease: (partyId: string, reason: string) => Promise<void>;
}>) {
  const { t } = useI18n();
  const th = t.weldbooksUs.payments.holds;
  const [releasing, setReleasing] = useState<RunHoldView | null>(null);

  return (
    <div>
      <p className="px-4 pb-3 pt-4 text-sm text-muted-foreground">{th.description}</p>
      <TabListScope>
        <div className={LIST_BORDER}>
          {run.holds.map((hold) => (
            <HoldRow
              key={`${hold.partyId}-${hold.code}`}
              hold={hold}
              nameOf={nameOf}
              canRelease={canRelease}
              onReleaseClick={setReleasing}
            />
          ))}
        </div>
      </TabListScope>

      <ReasonDialog
        open={releasing !== null}
        onOpenChange={(open) => {
          if (!open) setReleasing(null);
        }}
        title={th.releaseTitle.replace('{vendor}', releasing?.partyName ?? '')}
        description={th.releaseDescription}
        label={th.releaseReason}
        submitLabel={th.release}
        onSubmit={async (reason) => {
          if (releasing) await onRelease(releasing.partyId, reason);
        }}
      />
    </div>
  );
}
