/**
 * WeldBooks › Annual reports: the KvK jaarrekeningen of a Dutch entity, one
 * per financial year. A row opens the report; "New annual report" starts one
 * from the ledger. Rust edition only (`annual-reports` feature).
 */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BookCheck } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { EmptyStateIllustration, type ColumnDef } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { JurisdictionGate } from '@/components/accounting/jurisdiction-gate';
import { RowText, RowTitle } from '@/components/accounting/weldbooks-row-cells';
import { PreprodBadge } from '@/components/accounting/digipoort-filing';
import { useAnnualReports, useCreateAnnualReport } from '@/hooks/queries/use-annual-report-queries';
import { isFeatureAvailable } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import type { AnnualReport } from '@/lib/weldbooks/annual-report-model';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { AnnualReportStatusChip } from './annual-report-status';
import { NewAnnualReportDialog } from './components/new-annual-report-dialog';

/** What a failed request says, and the id of the report that blocked a create (409). */
function conflictId(error: unknown): string | null {
  const body = (error as { status?: number; body?: unknown } | null)?.body;
  if ((error as { status?: number } | null)?.status !== 409 || !body || typeof body !== 'object') return null;
  const id = (body as { error?: { details?: { id?: unknown } } }).error?.details?.id;
  return typeof id === 'string' ? id : null;
}

function AnnualReportsList() {
  const { t } = useI18n();
  const ta = t.weldbooksNl.annualReports;
  const { formatDate } = useWeldbooksFormat();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const { data, isLoading, error } = useAnnualReports();
  const createMutation = useCreateAnnualReport();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (error) return <ErrorState className="m-4 sm:m-6" message={ta.loadFailed} />;

  const reports = data?.data ?? [];
  const open = (id: string) => void navigate({ to: '/weldbooks/annual-reports/$id', params: { id } });

  const handleCreate = (values: Parameters<typeof createMutation.mutate>[0]) => {
    createMutation.mutate(values, {
      onSuccess: (res) => {
        toast.success(ta.create.created);
        setDialogOpen(false);
        open(res.data.id);
      },
      onError: (err) => {
        const existing = conflictId(err);
        if (existing) {
          toast.info(ta.create.exists.replace('{year}', String(values.fiscalYear)));
          setDialogOpen(false);
          open(existing);
          return;
        }
        toast.error(ta.create.failed, { description: err instanceof Error ? err.message : undefined });
      },
    });
  };

  const columns: ColumnDef<AnnualReport>[] = [
    {
      id: 'year',
      header: ta.colYear,
      width: 'min-w-0 flex-1 gap-2 @2xl/list:min-w-[160px]',
      render: (report) => <RowTitle chips={<PreprodBadge row={report} />}>{report.fiscalYear}</RowTitle>,
    },
    {
      id: 'size',
      header: ta.colSize,
      width: 'hidden shrink-0 @3xl/list:flex w-[110px]',
      render: (report) => <RowText>{ta.sizeClasses[report.sizeClass]}</RowText>,
    },
    {
      id: 'status',
      header: ta.colStatus,
      width: 'shrink-0 w-[120px]',
      render: (report) => <AnnualReportStatusChip status={report.status} />,
    },
    {
      id: 'filedAt',
      header: ta.colFiledOn,
      width: 'hidden shrink-0 @3xl/list:flex w-[130px]',
      render: (report) => <RowText>{report.filedAt ? formatDate(report.filedAt) : null}</RowText>,
    },
    {
      id: 'reference',
      header: ta.colReference,
      width: 'hidden shrink-0 @4xl/list:flex w-[200px]',
      render: (report) => <RowText>{report.filingReference}</RowText>,
    },
  ];

  const canCreate = can('reports:create');
  const create = canCreate ? { label: ta.new, onClick: () => setDialogOpen(true) } : undefined;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <WeldbooksEntityList<AnnualReport>
        items={reports}
        isLoading={false}
        columns={columns}
        onRowClick={(report) => open(report.id)}
        getRowLabel={(report) => ta.detail.title.replace('{year}', String(report.fiscalYear))}
        filters={[]}
        createButton={create}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <BookCheck className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: ta.emptyTitle,
          description: ta.emptyDescription,
          action: create,
        }}
      />
      <NewAnnualReportDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        pending={createMutation.isPending}
        existingYears={reports.map((report) => report.fiscalYear)}
        onSubmit={handleCreate}
      />
    </div>
  );
}

export default function AnnualReportsPage() {
  const { t } = useI18n();
  const ta = t.weldbooksNl.annualReports;
  return (
    <JurisdictionGate
      feature={ta.title}
      when={({ features }) => features.vatReturn && isFeatureAvailable('annual-reports')}
    >
      <AnnualReportsList />
    </JurisdictionGate>
  );
}
