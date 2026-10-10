import { useState } from 'react';
import { ArrowLeft, EllipsisVertical, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Link, useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import {
  useDeleteProjectAnalyticsReport,
  useUpdateProjectAnalyticsReport,
} from '@/hooks/queries/use-projects-queries';

interface ReportBackLinkProps {
  basePath: string;
}

/** "Back to reports" link shown above a report's title. */
export function ReportBackLink({ basePath }: Readonly<ReportBackLinkProps>) {
  const { t } = useI18n();
  return (
    <Link
      href={basePath}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft className="h-4 w-4" />
      {t.projects.analyticsReports.backToReports}
    </Link>
  );
}

interface ReportActionsMenuProps {
  reportId: string;
  title: string;
  basePath: string;
  /** Called with the saved title after a successful rename. */
  onRenamed: (title: string) => void;
}

/** Rename / delete menu for a report, usable whether or not the report has charts yet. */
export function ReportActionsMenu({ reportId, title, basePath, onRenamed }: Readonly<ReportActionsMenuProps>) {
  const { t } = useI18n();
  const router = useRouter();
  const updateReport = useUpdateProjectAnalyticsReport();
  const deleteReport = useDeleteProjectAnalyticsReport();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);

  const handleRename = async () => {
    const next = draftTitle.trim();
    if (!next) return;
    try {
      await updateReport.mutateAsync({ reportId, data: { title: next } });
      onRenamed(next);
      setRenameOpen(false);
      toast.success(t.projects.analyticsReports.reportUpdated);
    } catch (error) {
      console.error('Failed to update report:', error);
      toast.error(t.projects.analyticsReports.reportUpdateFailed);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteReport.mutateAsync(reportId);
      toast.success(t.projects.analyticsReports.reportDeleted);
      router.push(basePath);
    } catch (error) {
      console.error('Failed to delete report:', error);
      toast.error(t.projects.analyticsReports.reportDeleteFailed);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label={t.projects.analyticsReports.reportActions}>
            <EllipsisVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setDraftTitle(title);
              setRenameOpen(true);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" />
            {t.projects.analyticsReports.editReport}
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="mr-2 h-4 w-4" />
            {t.projects.analyticsReports.deleteReport}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.analyticsReports.editReport}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-report-title">{t.projects.analyticsReports.titleLabel}</Label>
            <Input
              id="rename-report-title"
              value={draftTitle}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraftTitle(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleRename();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {t.projects.analyticsReports.cancel}
            </Button>
            <Button onClick={handleRename} disabled={updateReport.isPending || !draftTitle.trim()}>
              {updateReport.isPending ? t.projects.analyticsReports.saving : t.projects.analyticsReports.saveChanges}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.analyticsReports.deleteReport}</DialogTitle>
            <DialogDescription>
              {t.projects.analyticsReports.deleteReportConfirm.replace('{title}', title)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t.projects.analyticsReports.cancel}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteReport.isPending}>
              {deleteReport.isPending ? t.projects.analyticsReports.deleting : t.projects.analyticsReports.deleteAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
