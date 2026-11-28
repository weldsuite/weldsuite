/**
 * Finance › Invoicing (edition feature `books-time-billing`): what of a project is invoiced, in
 * draft and still to invoice, from WeldBooks (`/api/accounting-projects/:id/finance`), with the
 * costs booked to it. "Invoice unbilled hours" opens the Unbilled time page for this project.
 * Each figure is per currency: a project billed in two shows both, never a made-up total.
 */

import { Clock, FilePen, Receipt, Wallet } from 'lucide-react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { isTimeBillingAvailable, useProjectInvoicing } from '@/hooks/queries/use-weldbooks-time-billing-queries';
import type { FinanceAmount } from '@/lib/api/domains/weldbooks-time-billing';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useParams } from '@/lib/router';
import { describeSums } from '@/lib/weldbooks/contact-page';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** One figure of the page: the first currency in full, the others under it. */
function AmountCard({
  label,
  amounts,
  icon,
  hint,
}: Readonly<{ label: string; amounts: readonly FinanceAmount[]; icon: typeof Wallet; hint?: string }>) {
  const { t } = useI18n();
  const { formatMoney } = useWeldbooksFormat();
  const sums = describeSums(amounts, formatMoney);
  const others = sums.others.length > 0 ? t.weldbooksContactPage.tiles.moreCurrencies.replace('{amounts}', sums.others.join(', ')) : null;
  return <KpiCard label={label} value={sums.primary} icon={icon} hint={others ?? hint} />;
}

export default function ProjectInvoicingPage() {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.flow.finance;
  const { projectId = '' } = useParams<{ projectId: string }>();
  const permissions = usePermissionsMaybe();
  const { formatNumber } = useWeldbooksFormat();
  const canRead = permissions?.can('invoices:read') ?? false;
  const query = useProjectInvoicing(projectId, { enabled: canRead });

  if (!isTimeBillingAvailable()) return <EditionUnavailablePage />;
  if (!permissions || !canRead) {
    return <p className="p-6 text-center text-sm text-muted-foreground">{copy.noAccess}</p>;
  }
  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.isError || !query.data) {
    return <ErrorState message={copy.loadFailed} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const canInvoice = permissions.can('invoices:create') && permissions.can('time:read');
  const hasUnbilled = Boolean(data.unbilled) && Number(data.unbilled?.hours) > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{copy.title}</h2>
          <p className="text-sm text-muted-foreground">{copy.description}</p>
        </div>
        {canInvoice && hasUnbilled ? (
          <Button asChild>
            <Link href={`/weldbooks/time/unbilled?projectId=${encodeURIComponent(projectId)}`}>{copy.invoiceUnbilled}</Link>
          </Button>
        ) : null}
      </div>

      <KpiGrid>
        <AmountCard label={copy.invoiced} amounts={data.invoiced} icon={Receipt} />
        <AmountCard label={copy.draft} amounts={data.draft} icon={FilePen} />
        {data.unbilled ? (
          <>
            <KpiCard
              label={copy.unbilled}
              value={t.weldbooksContactPage.unbilled.hours.replace('{hours}', formatNumber(data.unbilled.hours))}
              icon={Clock}
            />
            <AmountCard label={copy.unbilledAmount} amounts={data.unbilled.amount} icon={Clock} />
          </>
        ) : null}
        {data.costs ? <AmountCard label={copy.costs} amounts={data.costs} icon={Wallet} /> : null}
      </KpiGrid>
    </div>
  );
}
