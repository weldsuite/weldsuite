import { useState } from 'react';
import { Loader2, RefreshCw, Rocket, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import {
  useDeleteMergeRelease,
  useMergeRelease,
  useRefreshMergeRelease,
  useShipMergeRelease,
} from '@/hooks/queries/use-weldmerge-across-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useParams, useRouter } from '@/lib/router';
import { fill, relativeTime } from '../../lib/format';
import { PublishReleaseDialog } from '../publish-dialog';
import { ReleaseNotesCard } from './release-notes-card';
import { ReleaseIssuesAndTickets, ReleasePullRequests } from './release-lists';

/**
 * A release: the merged pull requests between its refs, the issues and the
 * waiting customers they carry, editable Markdown notes (written by AI on
 * request), and the steps that finish it: ship, then publish.
 */
export default function WeldMergeReleasePage() {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const tr = tm.across.releases;
  const td = tr.detail;
  const router = useRouter();
  const { releaseId } = useParams() as { releaseId: string };
  const canManage = useCan('merge_releases:manage');

  const query = useMergeRelease(releaseId);
  const refresh = useRefreshMergeRelease();
  const ship = useShipMergeRelease();
  const remove = useDeleteMergeRelease();

  const [confirmShip, setConfirmShip] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const release = query.data;

  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.isError || !release) {
    return <ErrorState message={td.notFound} retryLabel={tm.retry} onRetry={() => void query.refetch()} />;
  }

  const draft = release.status === 'draft';
  const canEdit = canManage && draft;

  const doRefresh = () =>
    refresh.mutate(release.id, {
      onSuccess: () => toast.success(td.refreshed),
      onError: () => toast.error(td.refreshFailed),
    });

  const doShip = async () => {
    try {
      await ship.mutateAsync(release.id);
      setConfirmShip(false);
      toast.success(td.shipped);
    } catch {
      toast.error(td.shipFailed);
    }
  };

  const doDelete = async () => {
    try {
      await remove.mutateAsync(release.id);
      toast.success(td.deleted);
      router.push('/weldmerge/releases');
    } catch {
      toast.error(td.deleteFailed);
    }
  };

  const refsLine = fill(td.repositoryLine, {
    repository: release.repositoryFullName,
    base: release.baseRef ?? td.noRefs,
    head: release.headRef ?? 'HEAD',
  });
  const noRefs = release.baseRef === null && release.headRef === null;
  const shippedAt = release.shippedAt
    ? ` · ${fill(td.shippedAt, { time: relativeTime(release.shippedAt, language, tm.justNow) })}`
    : '';

  return (
    <DetailPage>
      <DetailHeader
        onBack={() => router.push('/weldmerge/releases')}
        backLabel={td.back}
        leading={<Rocket className="mt-2 size-6 text-muted-foreground" />}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {release.name}
            {release.version && <span className="text-lg font-normal text-muted-foreground">{release.version}</span>}
            <SoftBadge tone={draft ? 'neutral' : 'success'}>{tr.status[release.status]}</SoftBadge>
          </span>
        }
        subtitle={
          <span>
            {noRefs ? `${release.repositoryFullName}, ${td.noRefs}` : refsLine}
            {shippedAt}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <Button variant="outline" onClick={doRefresh} disabled={refresh.isPending}>
                {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {td.refresh}
              </Button>
            )}
            {canManage && (
              <Button variant="outline" onClick={() => setPublishing(true)}>
                <Send />
                {td.publish}
              </Button>
            )}
            {canEdit && (
              <Button onClick={() => setConfirmShip(true)}>
                <Rocket />
                {td.ship}
              </Button>
            )}
            {canManage && (
              <Button variant="ghost" size="icon" aria-label={td.deleteRelease} onClick={() => setConfirmDelete(true)}>
                <Trash2 />
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <ReleaseNotesCard release={release} canEdit={canEdit} />
          <ReleasePullRequests release={release} />
        </div>
        <aside className="space-y-6">
          <ReleaseIssuesAndTickets release={release} />
        </aside>
      </div>

      <ConfirmDialog
        open={confirmShip}
        onOpenChange={setConfirmShip}
        title={fill(td.shipTitle, { name: release.name })}
        description={td.shipDescription}
        confirmLabel={td.shipConfirm}
        loading={ship.isPending}
        onConfirm={doShip}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={fill(td.deleteTitle, { name: release.name })}
        description={td.deleteDescription}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={doDelete}
      />
      <PublishReleaseDialog open={publishing} onOpenChange={setPublishing} release={release} />
    </DetailPage>
  );
}
