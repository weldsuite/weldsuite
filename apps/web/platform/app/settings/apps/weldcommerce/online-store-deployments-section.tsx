/**
 * The deployments of an online store built with the merchant's own code: each
 * upload with its status, size and preview link; the production one is what
 * visitors see. An upload is promoted to production (`websites:manage`) or
 * deleted (`websites:delete`, never the production one). Below, how to deploy
 * with the WeldSuite command line tool and a deploy key of the channel.
 */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ExternalLink, Rocket, Trash2, UploadCloud } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  useDeleteDeployment,
  usePromoteDeployment,
  useStoreDeployments,
  type DeploymentStatus,
  type OnlineStoreSite,
  type StoreDeployment,
} from '@/hooks/queries/use-online-store-queries';
import { getLocale, getTranslations } from '@/lib/i18n';
import { CopyBox } from '@/app/weldcommerce/lib/copy-box';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';

const STATUS_TONES: Record<DeploymentStatus, SoftTone> = { uploading: 'warning', ready: 'success', failed: 'danger' };

export const DEPLOY_COMMAND = 'WELDCOMMERCE_DEPLOY_KEY=wcd_… weld storefront deploy';

/** A byte count as kB / MB in the platform language. */
export function formatBytes(bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  try {
    return new Intl.NumberFormat(getLocale(), { style: 'unit', unit: units[unit], unitDisplay: 'short', maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  } catch {
    return `${Math.round(value)} ${units[unit]}`;
  }
}

function deploymentDate(deployment: StoreDeployment): string {
  const date = new Date(deployment.createdAt);
  if (Number.isNaN(date.getTime())) return deployment.createdAt;
  return date.toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

type Pending = { kind: 'promote' | 'remove'; deployment: StoreDeployment };

export function OnlineStoreDeploymentsSection({
  site,
  canManage,
  canDelete,
}: Readonly<{ site: OnlineStoreSite; canManage: boolean; canDelete: boolean }>) {
  const t = getTranslations('commerce').onlineStore.settingsTab.deployments;
  const copyLabels = getTranslations('commerce').channels.keys.secret;
  const deployments = useStoreDeployments(site.id);
  const promote = usePromoteDeployment();
  const remove = useDeleteDeployment();
  const [pending, setPending] = useState<Pending | null>(null);
  const rows = deployments.data?.data ?? [];

  const confirm = async () => {
    if (!pending) return;
    try {
      if (pending.kind === 'promote') {
        await promote.mutateAsync({ siteId: site.id, deploymentId: pending.deployment.id });
        toast.success(t.promoted);
      } else {
        await remove.mutateAsync({ siteId: site.id, deploymentId: pending.deployment.id });
        toast.success(t.removed);
      }
    } catch (err) {
      toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    } finally {
      setPending(null);
    }
  };

  let body;
  if (deployments.isPending) body = <PageLoader fullScreen={false} />;
  else if (deployments.isError) body = <ErrorState message={t.loadFailed} onRetry={() => void deployments.refetch()} />;
  else if (rows.length === 0) body = <EmptyState icon={UploadCloud} title={t.empty} description={t.emptyDescription} />;
  else {
    body = (
      <div className="@container rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.columns.created}</TableHead>
              <TableHead>{t.columns.status}</TableHead>
              <TableHead className="hidden @xl:table-cell">{t.columns.files}</TableHead>
              <TableHead>
                <span className="sr-only">{t.columns.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((deployment) => {
              const date = deploymentDate(deployment);
              return (
                <TableRow key={deployment.id}>
                  <TableCell className="whitespace-nowrap tabular-nums">{date}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      <SoftBadge tone={STATUS_TONES[deployment.status] ?? 'neutral'}>{t.status[deployment.status] ?? deployment.status}</SoftBadge>
                      {deployment.isProduction && <SoftBadge tone="success">{t.production}</SoftBadge>}
                    </span>
                    {deployment.error && <span className="mt-1 block text-xs text-destructive">{deployment.error}</span>}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap tabular-nums @xl:table-cell">
                    {fill(t.filesSize, { count: deployment.fileCount, size: formatBytes(deployment.totalBytes) })}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {deployment.previewUrl && (
                        <Button asChild variant="ghost" size="sm">
                          <a href={deployment.previewUrl} target="_blank" rel="noopener noreferrer" aria-label={fill(t.previewLabel, { date })}>
                            <ExternalLink className="h-4 w-4" aria-hidden="true" />
                            <span className="hidden @2xl:inline">{t.preview}</span>
                          </a>
                        </Button>
                      )}
                      {canManage && deployment.status === 'ready' && !deployment.isProduction && (
                        <Button type="button" variant="ghost" size="sm" aria-label={fill(t.promoteLabel, { date })} onClick={() => setPending({ kind: 'promote', deployment })}>
                          <Rocket className="h-4 w-4" aria-hidden="true" />
                          <span className="hidden @2xl:inline">{t.promote}</span>
                        </Button>
                      )}
                      {canDelete && !deployment.isProduction && (
                        <Button type="button" variant="ghost" size="icon" aria-label={fill(t.removeLabel, { date })} onClick={() => setPending({ kind: 'remove', deployment })}>
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  const pendingDate = pending ? deploymentDate(pending.deployment) : '';
  return (
    <SettingsSection title={t.title} description={t.description}>
      {body}
      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <h3 className="text-sm font-semibold">{t.howTitle}</h3>
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            {fill(t.howKey, { channel: site.channelName })}{' '}
            <Link
              to="/settings/apps/weldcommerce"
              search={{ tab: 'channels', channel: site.channelId }}
              className="font-medium text-primary underline underline-offset-4"
            >
              {t.howKeyLink}
            </Link>
          </li>
          <li className="space-y-2">
            <p>{t.howUpload}</p>
            <CopyBox value={DEPLOY_COMMAND} label={t.command} labels={{ ...copyLabels, copyLabel: t.copyCommand }} rows={1} />
          </li>
          <li>{t.howProd}</li>
        </ol>
      </div>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.kind === 'remove' ? t.removeTitle : t.promoteTitle}
        description={pending?.kind === 'remove' ? fill(t.removeDescription, { date: pendingDate }) : fill(t.promoteDescription, { date: pendingDate })}
        variant={pending?.kind === 'remove' ? 'destructive' : 'default'}
        confirmLabel={pending?.kind === 'remove' ? t.remove : t.promote}
        cancelLabel={getTranslations('common').actions.cancel}
        onConfirm={confirm}
      />
    </SettingsSection>
  );
}
