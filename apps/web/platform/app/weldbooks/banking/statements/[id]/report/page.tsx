import { createPortal } from 'react-dom';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useBankReconciliationReport } from '@/hooks/queries/use-weldbooks-banking-queries';
import { ReconciliationReportView } from '../../components/report-view';

/**
 * Printing: the report is also rendered into a container directly under
 * `<body>` (outside the app shell and its scrolling panes), and the print
 * stylesheet hides everything but that container, so the browser's "Save as
 * PDF" gets the report alone and paginates it normally.
 */
const PRINT_CSS = `
[data-reconciliation-print] { display: none; }
@media print {
  body > *:not([data-reconciliation-print]) { display: none !important; }
  [data-reconciliation-print] { display: block !important; }
  @page { margin: 14mm; }
}
`;

export default function StatementReportPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { t } = useI18n();
  const tr = t.weldbooksUs.banking.report;
  const { formatMoney, formatDate, entityCurrency } = useWeldbooksFormat();
  const { data: report, isLoading, isError } = useBankReconciliationReport(id);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (isError || !report) {
    return (
      <div className="p-6">
        <Link to="/weldbooks/banking/statements" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="h-4 w-4" /> {tr.back}
        </Link>
        <p className="mt-4">{tr.notFound}</p>
      </div>
    );
  }

  const money = (amount: number) => formatMoney(amount, entityCurrency);
  const open = report.status === 'in_progress';

  return (
    <div className="max-w-5xl space-y-4 p-6">
      <style>{PRINT_CSS}</style>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/weldbooks/banking/statements" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="h-4 w-4" /> {tr.back}
        </Link>
        <div className="flex items-center gap-2">
          {open ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/weldbooks/banking/statements/$id" params={{ id }}>{tr.backToWorksheet}</Link>
            </Button>
          ) : null}
          <Button size="sm" onClick={() => window.print()} data-testid="print-report">
            <Printer className="h-4 w-4" />
            {tr.print}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <ReconciliationReportView report={report} formatAmount={money} formatDate={formatDate} />
        </CardContent>
      </Card>

      {createPortal(
        <div data-reconciliation-print>
          <ReconciliationReportView report={report} formatAmount={money} formatDate={formatDate} print />
        </div>,
        document.body,
      )}
    </div>
  );
}
