
import { useState } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Link, useRouter } from '@/lib/router';
import { formatDate } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { Plus, EllipsisVertical, Pencil, Copy, Trash2, BarChart3 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { EntityList, EmptyStateIllustration, type HeaderColumn } from '@/components/entity-list';
import { toast } from 'sonner';
import {
  useCreateProjectAnalyticsReport,
  useUpdateProjectAnalyticsReport,
  useDeleteProjectAnalyticsReport,
} from '@/hooks/queries/use-projects-queries';

// Type definition for analytics report (previously imported from actions)
export interface AnalyticsReport {
  id: string;
  title: string;
  description?: string;
  chartCount: number;
  createdAt: string;
  updatedAt: string;
}

interface AnalyticsListClientProps {
  reports: AnalyticsReport[];
  /** Base path for report links (default `/weldflow/analytics`). */
  basePath?: string;
  /** When true, omit page title/description (used under KPI hub). */
  embedded?: boolean;
  /** Section heading when embedded. */
  sectionTitle?: string;
  /** Render reports as cards (default) or as a standalone EntityList of table rows. */
  layout?: 'grid' | 'table';
}

export function AnalyticsListClient({
  reports,
  basePath = '/weldflow/analytics',
  embedded = false,
  sectionTitle,
  layout = 'grid',
}: Readonly<AnalyticsListClientProps>) {
  const { t } = useI18n();
  // When embedded under a KPI hub, the parent page owns the breadcrumb trail.
  useBreadcrumbs(
    [
      { label: t.projects.title, href: '/weldflow' },
      { label: t.projects.analytics.title },
    ],
    { enabled: !embedded },
  );

  const router = useRouter();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedReport, setSelectedReport] = useState<AnalyticsReport | null>(null);
  const [formData, setFormData] = useState({ title: '', description: '' });

  const createReportMutation = useCreateProjectAnalyticsReport();
  const updateReportMutation = useUpdateProjectAnalyticsReport();
  const deleteReportMutation = useDeleteProjectAnalyticsReport();

  const isLoading = createReportMutation.isPending || updateReportMutation.isPending || deleteReportMutation.isPending;

  const handleCreate = async () => {
    if (!formData.title.trim()) {
      toast.error(t.projects.analyticsReports.titleRequired);
      return;
    }

    try {
      const result = await createReportMutation.mutateAsync(formData);
      if (result.data?.id) {
        setIsCreateDialogOpen(false);
        setFormData({ title: '', description: '' });
        toast.success(t.projects.analyticsReports.reportCreated);
        router.push(`${basePath}/${result.data.id}`);
      } else {
        toast.error(t.projects.analyticsReports.reportCreatedFailed);
      }
    } catch {
      toast.error(t.projects.analyticsReports.reportCreatedFailed);
    }
  };

  const handleEdit = async () => {
    if (!selectedReport || !formData.title.trim()) return;

    try {
      await updateReportMutation.mutateAsync({
        reportId: selectedReport.id,
        data: formData,
      });
      setIsEditDialogOpen(false);
      setSelectedReport(null);
      setFormData({ title: '', description: '' });
      toast.success(t.projects.analyticsReports.reportUpdated);
    } catch {
      toast.error(t.projects.analyticsReports.reportUpdateFailed);
    }
  };

  const handleDelete = async () => {
    if (!selectedReport) return;

    try {
      await deleteReportMutation.mutateAsync(selectedReport.id);
      setIsDeleteDialogOpen(false);
      setSelectedReport(null);
      toast.success(t.projects.analyticsReports.reportDeleted);
    } catch {
      toast.error(t.projects.analyticsReports.reportDeleteFailed);
    }
  };

  const openEditDialog = (report: AnalyticsReport) => {
    setSelectedReport(report);
    setFormData({ title: report.title, description: report.description || '' });
    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (report: AnalyticsReport) => {
    setSelectedReport(report);
    setIsDeleteDialogOpen(true);
  };

  const chartCountLabel = (count: number) =>
    (count !== 1 ? t.projects.analyticsReports.charts : t.projects.analyticsReports.chart).replace('{count}', String(count));

  const renderActions = (report: AnalyticsReport) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => openEditDialog(report)}>
          <Pencil className="mr-0.5 h-4 w-4" />
          {t.projects.actions.edit}
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Copy className="mr-0.5 h-4 w-4" />
          {t.projects.actions.duplicate}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openDeleteDialog(report)} className="text-destructive">
          <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
          {t.projects.actions.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const headerColumns: HeaderColumn[] = [
    { id: 'title', header: t.projects.analyticsReports.titleLabel, width: 'min-w-[200px] flex-1' },
    { id: 'description', header: t.projects.analyticsReports.descriptionLabel, width: 'min-w-[200px] flex-1' },
    { id: 'charts', header: t.projects.analyticsReports.chartsLabel, width: 'w-[100px]' },
    { id: 'updated', header: t.projects.analyticsReports.updated, width: 'w-[120px]' },
  ];

  const renderRow = (report: AnalyticsReport) => (
    <div
      key={report.id}
      className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      onClick={() => router.push(`${basePath}/${report.id}`)}
    >
      {/* Title */}
      <div className="min-w-[200px] flex-1 flex items-center gap-2">
        <Link
          href={`${basePath}/${report.id}`}
          className="text-sm font-medium text-foreground truncate hover:underline"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {report.title}
        </Link>
      </div>

      {/* Description */}
      <div className="min-w-[200px] flex-1">
        <span className="block text-sm text-gray-600 dark:text-muted-foreground truncate">
          {report.description || t.projects.analyticsReports.noDescription}
        </span>
      </div>

      {/* Charts */}
      <div className="w-[100px]">
        <span className="text-sm text-gray-600 dark:text-muted-foreground tabular-nums">
          {report.chartCount}
        </span>
      </div>

      {/* Updated */}
      <div className="w-[120px]">
        <span className="text-sm text-gray-600 dark:text-muted-foreground">
          {formatDate(report.updatedAt)}
        </span>
      </div>

      {/* Actions */}
      <div role="presentation" className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
        {renderActions(report)}
      </div>
    </div>
  );

  const renderReports = () => {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {reports.map((report) => (
          <Card key={report.id} className="group hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <div className="space-y-1">
                <CardTitle className="text-base font-semibold">
                  <Link href={`${basePath}/${report.id}`} className="hover:underline">
                    {report.title}
                  </Link>
                </CardTitle>
                <CardDescription className="line-clamp-2">{report.description || t.projects.analyticsReports.noDescription}</CardDescription>
              </div>
              {renderActions(report)}
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  {chartCountLabel(report.chartCount)}
                </span>
                <span>{t.projects.analyticsReports.updated} {formatDate(report.updatedAt)}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  };

  const dialogs = (
    <>
    {/* Create Dialog */}
    <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.projects.analyticsReports.createReport}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">{t.projects.analyticsReports.titleLabel}</Label>
            <Input
              id="title"
              placeholder={t.projects.analyticsReports.titlePlaceholder}
              value={formData.title}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, title: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">{t.projects.analyticsReports.descriptionLabel}</Label>
            <Textarea
              id="description"
              placeholder={t.projects.analyticsReports.descriptionPlaceholder}
              value={formData.description}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
            {t.projects.analyticsReports.cancel}
          </Button>
          <Button onClick={handleCreate} disabled={isLoading || !formData.title.trim()}>
            {isLoading ? t.projects.analyticsReports.creating : t.projects.analyticsReports.createAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Edit Dialog */}
    <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.projects.analyticsReports.editReport}</DialogTitle>
          <DialogDescription>{t.projects.analyticsReports.editReportDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-title">{t.projects.analyticsReports.titleLabel}</Label>
            <Input
              id="edit-title"
              value={formData.title}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, title: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-description">{t.projects.analyticsReports.descriptionLabel}</Label>
            <Textarea
              id="edit-description"
              value={formData.description}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
            {t.projects.analyticsReports.cancel}
          </Button>
          <Button onClick={handleEdit} disabled={isLoading}>
            {isLoading ? t.projects.analyticsReports.saving : t.projects.analyticsReports.saveChanges}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Delete Dialog */}
    <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.projects.analyticsReports.deleteReport}</DialogTitle>
          <DialogDescription>
            {t.projects.analyticsReports.deleteReportConfirm.replace('{title}', selectedReport?.title ?? '')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
            {t.projects.analyticsReports.cancel}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isLoading}>
            {isLoading ? t.projects.analyticsReports.deleting : t.projects.analyticsReports.deleteAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );

  if (layout === 'table') {
    return (
      <>
        <div className="-mx-3 md:-mx-4 -mt-3 md:-mt-4">
          <EntityList<AnalyticsReport>
            items={reports}
            isLoading={false}
            error={null}
            headerColumns={headerColumns}
            filters={[]}
            renderRow={renderRow}
            searchPlaceholder={t.projects.analyticsReports.searchReports}
            searchFields={['title', 'description']}
            topBarClassName="pt-2 pb-2"
            stickyOffset={-16}
            createButton={{
              label: t.projects.analyticsReports.newReport,
              onClick: () => setIsCreateDialogOpen(true),
            }}
            emptyState={{
              icon: (
                <EmptyStateIllustration>
                  <BarChart3 className="h-12 w-12 text-gray-300 dark:text-muted-foreground" />
                </EmptyStateIllustration>
              ),
              title: t.projects.analyticsReports.noReports,
              description: t.projects.analyticsReports.noReportsDescription,
              action: {
                label: t.projects.analyticsReports.createFirstReport,
                onClick: () => setIsCreateDialogOpen(true),
              },
            }}
          />
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          {embedded ? (
            <h2 className="text-lg font-semibold tracking-tight">
              {sectionTitle ?? t.projects.dashboard.customReports}
            </h2>
          ) : (
            <>
              <h1 className="text-2xl font-bold tracking-tight">{t.projects.analyticsReports.title}</h1>
              <p className="text-muted-foreground">
                {t.projects.analyticsReports.description}
              </p>
            </>
          )}
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="mr-0.5 h-4 w-4" />
          {t.projects.analyticsReports.newReport}
        </Button>
      </div>

      {reports.length === 0 ? (
        <Card className="flex flex-col items-center justify-center p-12">
          <BarChart3 className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold">{t.projects.analyticsReports.noReports}</h3>
          <p className="text-muted-foreground text-center max-w-md mt-2">
            {t.projects.analyticsReports.noReportsDescription}
          </p>
          <Button className="mt-6" onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="mr-0.5 h-4 w-4" />
            {t.projects.analyticsReports.createFirstReport}
          </Button>
        </Card>
      ) : (
        renderReports()
      )}

      {dialogs}
    </div>
  );
}
