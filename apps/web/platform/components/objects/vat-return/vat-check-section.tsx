/**
 * The "Check" step of a VAT return (edition feature `books-questions`): what is
 * still open in the return's period, before it is filed. Each check shows its
 * count, its amount where it has one, up to five sample records as chips, and
 * a link to the list (or the processing view) where it is dealt with. A check
 * the member may not see says so. These are warnings: they never block filing,
 * and the file / mark-filed actions stay where they are.
 */

import { CheckCircle2, RefreshCw, TriangleAlert } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { RecordChip } from '@weldsuite/ui/components/record-chip';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { RecordLink } from '@/components/object-panel/record-link';
import { isQuestionsAvailable, useVatReturnChecks } from '@/hooks/queries/use-weldbooks-questions-queries';
import { VAT_CHECK_KEYS, type VatCheck, type VatCheckKey } from '@/lib/api/domains/weldbooks-questions';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { toPublicPath } from '@/lib/workspace-url-rewrite';
import { withQuery } from '@/lib/with-query';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const EMPTY_CHECK: VatCheck = { count: 0, sampleIds: [] };

/** Where each check is dealt with: real routes of the WeldBooks menu. */
export const VAT_CHECK_TARGETS: Record<VatCheckKey, string> = {
  unprocessed_bank_lines: '/weldbooks/banking/process',
  unbooked_documents: '/weldbooks/documents',
  missing_receipts: '/weldbooks/to-process',
  possible_duplicates: '/weldbooks/banking/transactions',
  draft_invoices_in_period: '/weldbooks/invoices?status=draft',
  open_transfers: '/weldbooks/banking/transactions',
};

/** The record a check's sample ids are: the panel type, or an inbox document (a page of its own). */
const SAMPLE_TYPE: Record<VatCheckKey, 'bank_transaction' | 'accounting_document' | 'invoice'> = {
  unprocessed_bank_lines: 'bank_transaction',
  unbooked_documents: 'accounting_document',
  missing_receipts: 'bank_transaction',
  possible_duplicates: 'bank_transaction',
  draft_invoices_in_period: 'invoice',
  open_transfers: 'bank_transaction',
};

function SampleChips({ checkKey, ids }: Readonly<{ checkKey: VatCheckKey; ids: readonly string[] }>) {
  const { t } = useI18n();
  const router = useRouter();
  const type = SAMPLE_TYPE[checkKey];
  const label = (index: number) => t.weldbooksQuestions.vatCheck.sample[type].replace('{n}', String(index + 1));
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t.weldbooksQuestions.vatCheck.items[checkKey]}>
      {ids.map((id, index) => (
        <li key={id} className="min-w-0">
          {type === 'accounting_document' ? (
            <RecordChip
              label={label(index)}
              href={toPublicPath(withQuery('/weldbooks/documents', `document=${encodeURIComponent(id)}`))}
              onOpen={() => router.push(withQuery('/weldbooks/documents', `document=${encodeURIComponent(id)}`))}
            />
          ) : (
            <RecordLink type={type} id={id} label={label(index)} />
          )}
        </li>
      ))}
    </ul>
  );
}

function CheckRow({ checkKey, check }: Readonly<{ checkKey: VatCheckKey; check: VatCheck }>) {
  const { t } = useI18n();
  const tv = t.weldbooksQuestions.vatCheck;
  const { formatMoney } = useWeldbooksFormat();
  const open = check.count > 0;
  const restricted = check.restricted === true;

  return (
    <li className="space-y-1.5 py-3" data-testid={`vat-check-${checkKey}`} data-open={open || restricted ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          {open && !restricted ? (
            <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          {tv.items[checkKey]}
        </span>
        {restricted ? (
          <span className="text-sm text-muted-foreground" data-testid={`vat-check-${checkKey}-restricted`}>
            {tv.restricted}
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-2">
            {check.amount ? (
              <span className="text-sm tabular-nums text-muted-foreground">
                {formatMoney(check.amount, check.currency ?? undefined)}
              </span>
            ) : null}
            <SoftBadge tone={open ? 'warning' : 'neutral'} data-testid={`vat-check-${checkKey}-count`}>
              {check.count}
            </SoftBadge>
          </span>
        )}
      </div>
      {!restricted && check.mixedCurrency && check.currency ? (
        <p className="text-xs text-muted-foreground">{tv.mixedCurrency.replace('{currency}', check.currency)}</p>
      ) : null}
      {!restricted && open && check.sampleIds.length > 0 ? <SampleChips checkKey={checkKey} ids={check.sampleIds} /> : null}
      {!restricted && open ? (
        <p>
          <Link
            href={VAT_CHECK_TARGETS[checkKey]}
            className="text-sm text-primary underline-offset-2 hover:underline"
            data-testid={`vat-check-${checkKey}-link`}
          >
            {tv.links[checkKey]}
          </Link>
        </p>
      ) : null}
    </li>
  );
}

/** The Check step. Renders nothing where the edition has no checks or the member may not read reports. */
export function VatCheckSection({ vatReturnId, filed }: Readonly<{ vatReturnId: string; filed: boolean }>) {
  const { t } = useI18n();
  const tv = t.weldbooksQuestions.vatCheck;
  const { can } = usePermissions();
  const allowed = isQuestionsAvailable() && can('reports:read');
  const checks = useVatReturnChecks(vatReturnId, { enabled: allowed });
  if (!allowed) return null;

  // A check this build asks for and the server did not send counts as empty (an older server).
  const rows = checks.data ? VAT_CHECK_KEYS.map((key) => [key, checks.data[key] ?? EMPTY_CHECK] as const) : [];
  const anythingOpen = rows.some(([, check]) => check.count > 0 || check.restricted === true);

  let body;
  if (checks.isError && !checks.data) {
    body = <ErrorState message={tv.loadFailed} onRetry={() => void checks.refetch()} />;
  } else if (!checks.data) {
    body = <InlineSpinner />;
  } else {
    body = (
      <>
        {!anythingOpen ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="vat-check-clear">
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            {tv.allClear}
          </p>
        ) : null}
        <ul className="divide-y">
          {rows.map(([key, check]) => (
            <CheckRow key={key} checkKey={key} check={check} />
          ))}
        </ul>
      </>
    );
  }

  return (
    <section
      aria-labelledby="vat-check-title"
      className="space-y-2 rounded-lg border p-3"
      data-testid="vat-check"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 id="vat-check-title" className="text-sm font-semibold">
            {tv.title}
          </h3>
          <p className="text-xs text-muted-foreground">{filed ? tv.filedNote : tv.description}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={checks.isFetching}
          onClick={() => void checks.refetch()}
        >
          <RefreshCw className="size-3.5" aria-hidden />
          {checks.isFetching ? tv.checking : tv.refresh}
        </Button>
      </div>
      {body}
    </section>
  );
}
