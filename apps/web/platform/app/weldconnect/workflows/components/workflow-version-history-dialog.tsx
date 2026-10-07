import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { AlertCircle, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { useI18n } from '@/lib/i18n/provider';
import {
  useWorkflowVersions,
  useRestoreWorkflowVersion,
  type WorkflowVersion,
} from '@/hooks/queries/use-automation-queries';
import { isUnsupportedWorkflowError } from '@/app/weldconnect/mvp';

interface WorkflowVersionHistoryDialogProps {
  workflowId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatWhen(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Read-only browsing of `versionHistory` (see services/workflow-versions.ts
 * in connect-api for the snapshot policy) with a Restore action per row. The
 * newest row is the workflow's current content and is never restorable.
 */
export function WorkflowVersionHistoryDialog({ workflowId, open, onOpenChange }: Readonly<WorkflowVersionHistoryDialogProps>) {
  const { t, language } = useI18n();
  const tv = t.weldconnect.versionHistory;
  const { data, isLoading, isError, refetch } = useWorkflowVersions(workflowId);
  const restore = useRestoreWorkflowVersion(workflowId);
  const [pendingRestore, setPendingRestore] = useState<WorkflowVersion | null>(null);

  const versions = data?.data ?? [];
  const newestVersion = versions.length > 0 ? Math.max(...versions.map((v) => v.version)) : null;

  const handleRestore = async (version: WorkflowVersion) => {
    try {
      await restore.mutateAsync(version.id);
      toast.success(tv.restoreSucceeded.replace('{version}', String(version.version)));
      setPendingRestore(null);
    } catch (err) {
      const message = isUnsupportedWorkflowError(err) ? tv.restoreFailedGate : tv.restoreFailed;
      toast.error(message);
      if (!isApiError(err)) setPendingRestore(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{tv.title}</DialogTitle>
            <DialogDescription>{tv.description}</DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {isError && !isLoading && (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <AlertCircle className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{tv.loadFailed}</p>
                <Button variant="outline" size="sm" onClick={() => refetch()}>
                  {tv.retry}
                </Button>
              </div>
            )}

            {!isLoading && !isError && versions.length === 0 && (
              <div className="flex flex-col items-center gap-1 py-8 text-center">
                <p className="text-sm font-medium">{tv.empty}</p>
                <p className="text-xs text-muted-foreground max-w-sm">{tv.emptyHint}</p>
              </div>
            )}

            {!isLoading && !isError && versions.length > 0 && (
              <ul className="divide-y">
                {versions.map((version) => {
                  const isCurrent = version.version === newestVersion;
                  return (
                    <li key={version.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">v{version.version}</span>
                          <Badge variant="outline" className="text-xs font-normal">
                            {tv.reasons[version.reason] ?? version.reason}
                          </Badge>
                          {isCurrent && (
                            <Badge variant="secondary" className="text-xs font-normal">
                              {tv.current}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatWhen(version.createdAt, language)}
                          {version.restoredFromVersion != null
                            ? ` · ${tv.restoredFromNote.replace('{version}', String(version.restoredFromVersion))}`
                            : ''}
                        </p>
                      </div>
                      {!isCurrent && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => setPendingRestore(version)}
                        >
                          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                          {tv.restore}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {tv.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingRestore != null} onOpenChange={(next) => !next && setPendingRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tv.restoreConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRestore ? tv.restoreConfirmDescription.replace('{version}', String(pendingRestore.version)) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.isPending}>{t.common.actions.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={restore.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (pendingRestore) void handleRestore(pendingRestore);
              }}
            >
              {restore.isPending ? tv.restoring : pendingRestore ? tv.restoreConfirmAction.replace('{version}', String(pendingRestore.version)) : tv.restore}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
