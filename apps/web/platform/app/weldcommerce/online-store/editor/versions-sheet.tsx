/**
 * The version history of an online store, in a drawer beside the editor:
 * every publish, newest first, the live one marked. An earlier version can
 * be made live again (`websites:manage`; the draft stays) or copied into the
 * draft to continue from it (`websites:update`; nothing changes for shoppers).
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import {
  useCopyVersionToDraft,
  useRestoreSiteVersion,
  useSiteVersions,
  type OnlineStoreSiteDetail,
  type SiteVersion,
} from '@/hooks/queries/use-online-store-queries';
import { formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { getTranslations } from '@/lib/i18n';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';

type Pending = { kind: 'restore' | 'copy'; version: SiteVersion };

export function VersionsSheet({
  open,
  onOpenChange,
  siteId,
  canRestore,
  canCopy,
  onCopied,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  canRestore: boolean;
  canCopy: boolean;
  /** The site with its new draft, after a version was copied into it. */
  onCopied: (site: OnlineStoreSiteDetail) => void;
}>) {
  const t = getTranslations('commerce').onlineStore.versions;
  const common = getTranslations('common');
  const saveFailed = getTranslations('commerce').common.saveFailed;
  const versions = useSiteVersions(siteId, open);
  const restore = useRestoreSiteVersion();
  const copy = useCopyVersionToDraft();
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = async () => {
    if (!pending) return;
    const { kind, version } = pending;
    try {
      if (kind === 'restore') {
        await restore.mutateAsync({ siteId, versionId: version.id });
        toast.success(fill(t.restored, { number: version.number }));
      } else {
        const res = await copy.mutateAsync({ siteId, versionId: version.id });
        onCopied(res.data);
        toast.success(fill(t.copied, { number: version.number }));
      }
    } catch (err) {
      toast.error(errorMessage(err, saveFailed));
    } finally {
      setPending(null);
    }
  };

  const rows = versions.data?.data ?? [];
  let body;
  if (versions.isPending) body = <PageLoader fullScreen={false} />;
  else if (versions.isError) body = <ErrorState message={t.loadFailed} onRetry={() => void versions.refetch()} />;
  else if (rows.length === 0) body = <EmptyText>{t.empty}</EmptyText>;
  else {
    body = (
      <ol className="divide-y">
        {rows.map((version) => (
          <li key={version.id} className="space-y-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{fill(t.version, { number: version.number })}</span>
              {version.isLive && <SoftBadge tone="success">{t.live}</SoftBadge>}
            </div>
            <p className="text-sm text-muted-foreground">{fill(t.publishedOn, { date: formatPanelDate(version.createdAt) ?? '' })}</p>
            {version.note && <p className="text-sm whitespace-pre-line">{version.note}</p>}
            {(canRestore || canCopy) && (
              <div className="flex flex-wrap gap-2">
                {canRestore && !version.isLive && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={fill(t.restoreLabel, { number: version.number })}
                    onClick={() => setPending({ kind: 'restore', version })}
                  >
                    {t.restore}
                  </Button>
                )}
                {canCopy && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={fill(t.copyLabel, { number: version.number })}
                    onClick={() => setPending({ kind: 'copy', version })}
                  >
                    {t.copy}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    );
  }

  const number = pending?.version.number ?? 0;
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t.title}</SheetTitle>
            <SheetDescription>{t.description}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">{body}</div>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={pending?.kind === 'copy' ? fill(t.copyTitle, { number }) : fill(t.restoreTitle, { number })}
        description={pending?.kind === 'copy' ? fill(t.copyDescription, { number }) : fill(t.restoreDescription, { number })}
        confirmLabel={pending?.kind === 'copy' ? t.copy : t.restore}
        cancelLabel={common.actions.cancel}
        onConfirm={confirm}
      />
    </>
  );
}
