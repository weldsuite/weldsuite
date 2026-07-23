
import { useState, useTransition, useMemo, useCallback } from 'react';
import { useRouter } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { EllipsisVertical, Copy, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { toast } from 'sonner';
import { useCreateAnalyticsReport, useDeleteAnalyticsReport, useDuplicateAnalyticsReport, type AnalyticsReport } from '@/hooks/queries/use-helpdesk-queries';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type RowHandlers } from '@/components/entity-list';

interface AnalyticsListClientProps {
  initialReports: AnalyticsReport[];
}

export function AnalyticsListClient({ initialReports }: AnalyticsListClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { t } = useI18n();
  const [reports, setReports] = useState<AnalyticsReport[]>(initialReports);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newReportTitle, setNewReportTitle] = useState('');
  const [newReportDescription, setNewReportDescription] = useState('');

  const createReportMutation = useCreateAnalyticsReport();
  const deleteReportMutation = useDeleteAnalyticsReport();
  const duplicateReportMutation = useDuplicateAnalyticsReport();

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: t.helpdesk.analyticsReports.title },
  ]);

  const openCreateDialog = () => {
    setNewReportTitle('');
    setNewReportDescription('');
    setCreateDialogOpen(true);
  };

  const handleCreateReport = async () => {
    if (!newReportTitle.trim()) return;

    createReportMutation.mutate(
      {
        title: newReportTitle.trim(),
        description: newReportDescription.trim() || 'Analytics report',
      },
      {
        onSuccess: (result) => {
          if (result.success && result.data) {
            setReports((prev) => [...prev, result.data]);
            setCreateDialogOpen(false);
            router.push(`/welddesk/analytics/${result.data.id}`);
          }
        },
      }
    );
  };

  const handleDeleteReport = async (reportId: string) => {
    deleteReportMutation.mutate(reportId, {
      onSuccess: (result) => {
        if (result.success) {
          setReports((prev) => prev.filter((r) => r.id !== reportId));
          toast.success(t.helpdesk.analyticsReports.reportDeleted);
        } else {
          toast.error(result.error || t.helpdesk.analyticsReports.failedToDeleteReport);
        }
      },
    });
  };

  const handleDuplicateReport = async (item: AnalyticsReport) => {
    duplicateReportMutation.mutate(item.id, {
      onSuccess: (result) => {
        if (result.success && result.data) {
          setReports((prev) => [...prev, result.data]);
          toast.success(t.helpdesk.analyticsReports.reportDuplicated);
        } else {
          toast.error(t.helpdesk.analyticsReports.failedToDuplicateReport);
        }
      },
    });
  };

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.helpdesk.analyticsReports.name, width: 'w-[400px]' },
    { id: 'description', header: t.helpdesk.analyticsReports.description, width: 'flex-1 min-w-[180px]' },
    { id: 'charts', header: t.helpdesk.analyticsReports.chartsLabel, width: 'w-[120px]' },
    { id: 'created', header: t.helpdesk.analyticsReports.created, width: 'w-[150px]' },
    { id: 'modified', header: t.helpdesk.analyticsReports.lastModified, width: 'w-[150px]' },
  ], [t]);

  const renderRow = useCallback((report: AnalyticsReport, handlers: RowHandlers<AnalyticsReport>) => {
    return (
      <div
        key={report.id}
        onClick={() => router.push(`/welddesk/analytics/${report.id}`)}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        {/* Name */}
        <div className="w-[400px]">
          <p className="text-sm font-medium text-gray-900 dark:text-foreground truncate">{report.title}</p>
        </div>

        {/* Description */}
        <div className="flex-1 min-w-[180px]">
          <p className="text-sm text-muted-foreground truncate">{report.description || '—'}</p>
        </div>

        {/* Charts */}
        <div className="w-[120px]">
          <span className="text-sm text-muted-foreground">{report.chartCount} {t.helpdesk.analyticsReports.charts}</span>
        </div>

        {/* Created */}
        <div className="w-[150px]">
          <span className="text-sm text-muted-foreground">{formatDate(report.createdAt)}</span>
        </div>

        {/* Last Modified */}
        <div className="w-[150px]">
          <span className="text-sm text-muted-foreground">{formatDate(report.updatedAt)}</span>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handlers.onDuplicate(report)}>
                <Copy className="h-4 w-4 mr-0.5" />
                {t.helpdesk.analyticsReports.duplicate}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handlers.onDelete(report.id)}
                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
              >
                <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
                {t.helpdesk.analyticsReports.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [router]);

  return (
    <>
      <EntityList<AnalyticsReport>
        items={reports}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        renderRow={renderRow}
        searchPlaceholder={t.helpdesk.analyticsReports.searchReports}
        searchFields={['title', 'description']}
        onDeleteItem={handleDeleteReport}
        onDuplicateItem={handleDuplicateReport}
        createButton={{
          label: t.helpdesk.analyticsReports.newReport,
          onClick: openCreateDialog,
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="140" viewBox="0 0 120 140" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}>
                <rect x="16" y="22" width="80" height="100" rx="6" className="fill-white dark:fill-white/[0.03]" />
                <rect x="16" y="22" width="80" height="100" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Chart bars */}
                <rect x="32" y="90" width="12" height="20" rx="2" className="fill-gray-200 dark:fill-white/20" />
                <rect x="50" y="75" width="12" height="35" rx="2" className="fill-gray-200 dark:fill-white/20" />
                <rect x="68" y="62" width="12" height="48" rx="2" className="fill-gray-200 dark:fill-white/20" />
                {/* Title lines */}
                <rect x="28" y="32" width="40" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
                <rect x="28" y="40" width="28" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.5" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t.helpdesk.analyticsReports.noReportsYet,
          description: t.helpdesk.analyticsReports.createFirstReport,
          action: {
            label: t.helpdesk.analyticsReports.newReport,
            onClick: openCreateDialog,
          },
        }}
        noResultsState={{
          title: t.helpdesk.analyticsReports.noReportsFound,
          description: t.helpdesk.analyticsReports.noReportsMatchSearch,
        }}
      />

      {/* Create Report Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t.helpdesk.analyticsReports.createNewReport}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="report-title">{t.helpdesk.analyticsReports.reportTitle}</Label>
              <Input
                id="report-title"
                placeholder={t.helpdesk.analyticsReports.reportTitlePlaceholder}
                value={newReportTitle}
                onChange={(e) => setNewReportTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateReport()}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="report-description">{t.helpdesk.analyticsReports.reportDescription}</Label>
              <Input
                id="report-description"
                placeholder={t.helpdesk.analyticsReports.reportDescriptionPlaceholder}
                value={newReportDescription}
                onChange={(e) => setNewReportDescription(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateReport()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {t.helpdesk.analyticsReports.cancel}
            </Button>
            <Button onClick={handleCreateReport} disabled={!newReportTitle.trim() || isPending}>
              {isPending ? t.helpdesk.analyticsReports.creating : t.helpdesk.analyticsReports.createReport}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
