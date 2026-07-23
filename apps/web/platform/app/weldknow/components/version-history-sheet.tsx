import { useState } from 'react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@weldsuite/ui/components/sheet';
import { getTranslations } from '@/lib/i18n';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useCreateKnowledgePageVersion,
  useKnowledgePageVersions,
  useRestoreKnowledgePageVersion,
  type KnowledgePageVersionSummary,
} from '@/hooks/queries/use-knowledge-queries';

interface VersionHistorySheetProps {
  pageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VersionHistorySheet({ pageId, open, onOpenChange }: VersionHistorySheetProps) {
  const t = getTranslations('weldknow');
  const { data, isLoading } = useKnowledgePageVersions(pageId, open);
  const createVersion = useCreateKnowledgePageVersion();
  const restoreVersion = useRestoreKnowledgePageVersion();

  const [label, setLabel] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<KnowledgePageVersionSummary | null>(null);

  const versions = data?.data ?? [];

  const handleCreate = async () => {
    try {
      await createVersion.mutateAsync({ pageId, label: label.trim() || undefined });
      setLabel('');
      toast.success(t.versions.createSuccess);
    } catch {
      toast.error(t.versions.createError);
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    try {
      await restoreVersion.mutateAsync({ pageId, versionId: restoreTarget.id });
      toast.success(t.versions.restoreSuccess);
    } catch {
      toast.error(t.versions.restoreError);
    } finally {
      setRestoreTarget(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md flex flex-col">
        <SheetHeader>
          <SheetTitle>{t.versions.title}</SheetTitle>
          <SheetDescription className="sr-only">{t.versions.title}</SheetDescription>
        </SheetHeader>

        <div className="flex items-center gap-2 px-4">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t.versions.createPlaceholder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreate();
              }
            }}
          />
          <Button type="button" onClick={handleCreate} disabled={createVersion.isPending} className="shrink-0">
            {t.versions.createButton}
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-2">
          {isLoading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : versions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
              <p className="text-sm font-medium">{t.versions.empty}</p>
              <p className="text-sm text-muted-foreground">{t.versions.emptyDescription}</p>
            </div>
          ) : (
            versions.map((version) => (
              <div
                key={version.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {version.label || t.versions.autoSnapshot}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(version.createdAt), { addSuffix: true })}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setRestoreTarget(version)}
                >
                  {t.versions.restore}
                </Button>
              </div>
            ))
          )}
        </div>
      </SheetContent>

      <ConfirmDialog
        open={!!restoreTarget}
        onOpenChange={(o) => !o && setRestoreTarget(null)}
        title={t.versions.restoreTitle}
        description={t.versions.restoreDescription}
        confirmLabel={t.versions.restore}
        cancelLabel={t.common.cancel}
        loading={restoreVersion.isPending}
        onConfirm={handleRestore}
      />
    </Sheet>
  );
}
