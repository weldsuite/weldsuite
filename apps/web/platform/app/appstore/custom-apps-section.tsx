
import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Puzzle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { usePermissions } from '@weldsuite/permissions/react';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { UserAppConsentDialog } from '@/components/weldapps/user-app-consent-dialog';
import { LucideDynamicIcon } from '@/components/lucide-dynamic-icon';
import {
  useUserAppStore,
  useInstallUserApp,
  useUninstallUserApp,
  useConsentUserAppScopes,
  SubscriptionRequiredError,
  type StoreUserApp,
} from '@/hooks/queries/use-user-apps-queries';

function CustomAppIcon({ icon, className = 'h-5 w-5' }: { icon?: string | null; className?: string }) {
  if (!icon) return <Puzzle className={className} />;
  return <LucideDynamicIcon name={icon} className={className} fallback={() => <Puzzle className={className} />} />;
}

/**
 * "Custom apps" section of the App Store — WeldApps created or installed by
 * this workspace (as opposed to the first-party system apps listed above).
 * Fed by `GET /user-apps/store`, which already scopes results to public
 * approved apps + this workspace's own apps and annotates each with
 * `installed` / `pendingScopes`.
 */
export function CustomAppsSection() {
  const { t, format } = useI18n();
  const wa = t.weldapps;
  const { can, isOwner } = usePermissions();
  const canManageWeldApps = isOwner || can('weldapps:manage');

  const { data: apps, isLoading } = useUserAppStore();
  const installMutation = useInstallUserApp();
  const uninstallMutation = useUninstallUserApp();
  const consentMutation = useConsentUserAppScopes();

  const [installTarget, setInstallTarget] = useState<StoreUserApp | null>(null);
  const [updateTarget, setUpdateTarget] = useState<StoreUserApp | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<StoreUserApp | null>(null);
  const [loadingCode, setLoadingCode] = useState<string | null>(null);

  const handleInstall = async () => {
    if (!installTarget) return;
    setLoadingCode(installTarget.code);
    try {
      await installMutation.mutateAsync({ id: installTarget.id, grantedScopes: installTarget.requestedScopes });
      toast.success(format(wa.store.installSuccess, { name: installTarget.name }));
      setInstallTarget(null);
    } catch (error) {
      if (error instanceof SubscriptionRequiredError) {
        toast.error(wa.store.subscriptionRequiredDescription);
      } else {
        toast.error(error instanceof Error ? error.message : wa.store.installError);
      }
    } finally {
      setLoadingCode(null);
    }
  };

  const handleApproveUpdate = async () => {
    if (!updateTarget) return;
    setLoadingCode(updateTarget.code);
    try {
      await consentMutation.mutateAsync({ id: updateTarget.id, approvedScopes: updateTarget.pendingScopes ?? [] });
      setUpdateTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : wa.store.installError);
    } finally {
      setLoadingCode(null);
    }
  };

  const handleUninstall = async () => {
    if (!uninstallTarget) return;
    setLoadingCode(uninstallTarget.code);
    try {
      await uninstallMutation.mutateAsync(uninstallTarget.id);
      toast.success(format(wa.store.uninstallSuccess, { name: uninstallTarget.name }));
      setUninstallTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : wa.store.uninstallError);
    } finally {
      setLoadingCode(null);
    }
  };

  return (
    <div className="scroll-mt-6">
      <div className="border-t border-dashed border-border my-8" />
      <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider mb-4 uppercase">
        {wa.store.sectionTitle}
      </h2>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <div key={i} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-start gap-3">
                <Skeleton className="w-10 h-10 rounded-[0.625rem] shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : !apps || apps.length === 0 ? (
        <div className="bg-card border border-dashed border-border rounded-xl p-6 text-center">
          <p className="text-sm font-medium text-foreground mb-1">{wa.store.empty}</p>
          <p className="text-xs text-muted-foreground">{wa.store.emptyDescription}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {apps.map((app) => {
            const isBusy = loadingCode === app.code;
            const needsApproval = app.installed && (app.pendingScopes?.length ?? 0) > 0;
            return (
              <div
                key={app.code}
                className="bg-card border border-border rounded-xl p-4 relative flex flex-col gap-3"
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-[0.625rem] bg-white dark:bg-background border border-gray-200 dark:border-border flex items-center justify-center shrink-0">
                    <CustomAppIcon icon={app.icon} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-px flex-wrap">
                      <h3 className="text-[0.9375rem] font-semibold text-foreground m-0 truncate">{app.name}</h3>
                      <Badge variant="outline" className="shrink-0">
                        {app.visibility === 'public' ? wa.store.badgeCommunity : wa.store.badgePrivate}
                      </Badge>
                      {app.pricingType === 'subscription' && app.priceMonthly ? (
                        <Badge variant="secondary" className="shrink-0">
                          {format(wa.store.priceMonthly, { price: `${app.currency ?? 'USD'} ${app.priceMonthly}` })}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground m-0">{app.category || wa.breadcrumb.title}</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground m-0 leading-[1.4] line-clamp-2">{app.description}</p>

                <div className="flex items-center gap-2 mt-auto pt-1">
                  {needsApproval && (
                    <Badge className="bg-amber-100 text-amber-700 border-transparent dark:bg-amber-950 dark:text-amber-400">
                      {wa.store.updateNeedsApproval}
                    </Badge>
                  )}
                  <div className="flex-1" />
                  {app.installed ? (
                    <>
                      <Button asChild variant="outline" size="sm" className="h-7 text-xs px-2.5">
                        <Link href={`/apps/${app.code}`}>{wa.store.open}</Link>
                      </Button>
                      {canManageWeldApps && needsApproval && (
                        <Button
                          size="sm"
                          className="h-7 text-xs px-2.5"
                          disabled={isBusy}
                          onClick={() => setUpdateTarget(app)}
                        >
                          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : wa.store.updateNeedsApproval}
                        </Button>
                      )}
                      {canManageWeldApps && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs px-2.5"
                          disabled={isBusy}
                          onClick={() => setUninstallTarget(app)}
                        >
                          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : wa.store.uninstall}
                        </Button>
                      )}
                    </>
                  ) : (
                    canManageWeldApps && (
                      <Button
                        size="sm"
                        className="h-7 text-xs px-2.5"
                        disabled={isBusy}
                        onClick={() => setInstallTarget(app)}
                      >
                        {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : wa.store.install}
                      </Button>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {installTarget && (
        <UserAppConsentDialog
          open={!!installTarget}
          onOpenChange={(open) => !open && setInstallTarget(null)}
          appName={installTarget.name}
          scopes={installTarget.requestedScopes}
          mode="install"
          onConfirm={handleInstall}
        />
      )}

      {updateTarget && (
        <UserAppConsentDialog
          open={!!updateTarget}
          onOpenChange={(open) => !open && setUpdateTarget(null)}
          appName={updateTarget.name}
          scopes={updateTarget.pendingScopes ?? []}
          mode="update"
          onConfirm={handleApproveUpdate}
        />
      )}

      <ConfirmDialog
        open={!!uninstallTarget}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
        title={format(wa.store.uninstallTitle, { name: uninstallTarget?.name ?? '' })}
        description={wa.store.uninstallDescription}
        confirmLabel={wa.store.uninstall}
        variant="destructive"
        onConfirm={handleUninstall}
      />
    </div>
  );
}
