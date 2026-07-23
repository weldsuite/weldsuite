
import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy, Loader2, Trash2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@weldsuite/ui/components/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@weldsuite/ui/components/table';
import { usePermissions } from '@weldsuite/permissions/react';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { UserAppConsentDialog } from '@/components/weldapps/user-app-consent-dialog';
import {
  useUserApp,
  useUserAppVersions,
  useDeleteUserApp,
  useSubmitUserApp,
  useInstallUserApp,
  useCreateUserAppOauthClient,
  useUserAppOauthClient,
  useInstalledUserApps,
  SubscriptionRequiredError,
  type UserApp,
} from '@/hooks/queries/use-user-apps-queries';
import { UploadVersionDialog } from './upload-version-dialog';

function formatBytes(bytes?: number | null): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

interface AppDetailPanelProps {
  appId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

export function AppDetailPanel({ appId, open, onOpenChange, onDeleted }: AppDetailPanelProps) {
  const { t, format } = useI18n();
  const wa = t.weldapps;
  const { can, isOwner } = usePermissions();
  const canPublish = isOwner || can('weldapps:publish');
  const canManage = isOwner || can('weldapps:manage');
  // Delete + OAuth client are developer actions (backend gates them on
  // weldapps:develop); canManage only covers install/uninstall.
  const canDevelop = isOwner || can('weldapps:develop');

  const { data: app, isLoading } = useUserApp(appId, open);
  const { data: versions, isLoading: versionsLoading } = useUserAppVersions(appId, open);
  const { data: installedApps } = useInstalledUserApps();
  const { data: oauthClient } = useUserAppOauthClient(appId, open);

  const deleteMutation = useDeleteUserApp();
  const submitMutation = useSubmitUserApp();
  const installMutation = useInstallUserApp();
  const createOauthMutation = useCreateUserAppOauthClient();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitNotes, setSubmitNotes] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [installConsentOpen, setInstallConsentOpen] = useState(false);
  const [newOauthSecret, setNewOauthSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const isInstalledHere = !!installedApps?.some((a) => a.appCode === app?.code);

  const handleSubmit = async () => {
    if (!app) return;
    try {
      await submitMutation.mutateAsync({ id: app.id, notes: submitNotes.trim() || undefined });
      toast.success(wa.submit.submitSuccess);
      setSubmitOpen(false);
      setSubmitNotes('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : wa.submit.submitError);
    }
  };

  const handleDelete = async () => {
    if (!app) return;
    try {
      await deleteMutation.mutateAsync(app.id);
      toast.success(wa.manage.deleteSuccess);
      setDeleteOpen(false);
      onOpenChange(false);
      onDeleted?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : wa.manage.deleteError);
    }
  };

  const handleInstall = async () => {
    if (!app) return;
    try {
      await installMutation.mutateAsync({ id: app.id, grantedScopes: app.requestedScopes });
      toast.success(format(wa.store.installSuccess, { name: app.name }));
      setInstallConsentOpen(false);
    } catch (error) {
      if (error instanceof SubscriptionRequiredError) {
        toast.error(wa.store.subscriptionRequiredDescription);
      } else {
        toast.error(error instanceof Error ? error.message : wa.store.installError);
      }
    }
  };

  const handleCreateOauth = async () => {
    if (!app) return;
    try {
      const result = await createOauthMutation.mutateAsync(app.id);
      setNewOauthSecret(result);
      toast.success(oauthClient ? wa.oauth.rotateSuccess : wa.oauth.createSuccess);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : wa.oauth.createError);
    }
  };

  const handleCopySecret = async () => {
    if (!newOauthSecret) return;
    await navigator.clipboard.writeText(newOauthSecret.clientSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reviewStatusLabel = (status: UserApp['reviewStatus']) => {
    switch (status) {
      case 'draft': return wa.manage.statusDraft;
      case 'submitted': return wa.manage.statusSubmitted;
      case 'approved': return wa.manage.statusApproved;
      case 'rejected': return wa.manage.statusRejected;
      default: return status;
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto p-6">
          <SheetHeader className="px-0">
            <SheetTitle>{app?.name ?? '…'}</SheetTitle>
            <SheetDescription>{app?.code}</SheetDescription>
          </SheetHeader>

          {isLoading || !app ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-6 mt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {app.visibility === 'public' ? wa.manage.visibilityPublic : wa.manage.visibilityPrivate}
                </Badge>
                <Badge variant={app.reviewStatus === 'rejected' ? 'destructive' : 'secondary'}>
                  {reviewStatusLabel(app.reviewStatus)}
                </Badge>
              </div>

              {app.reviewStatus === 'rejected' && app.reviewNotes && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <p className="text-xs font-medium text-destructive mb-1">{wa.manage.reviewNotesLabel}</p>
                  <p className="text-sm text-foreground">{app.reviewNotes}</p>
                </div>
              )}

              {/* Install shortcut */}
              <div className="flex items-center gap-2">
                {isInstalledHere ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/apps/${app.code}`}>{wa.store.open}</Link>
                  </Button>
                ) : (
                  canManage && (
                    <Button size="sm" onClick={() => setInstallConsentOpen(true)}>
                      {wa.manage.installInWorkspace}
                    </Button>
                  )
                )}
                {canPublish && app.reviewStatus === 'draft' && (
                  <Button size="sm" variant="outline" onClick={() => setSubmitOpen(true)}>
                    {wa.submit.button}
                  </Button>
                )}
              </div>

              {/* Versions */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-foreground">{wa.versions.title}</h3>
                  <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
                    {wa.versions.uploadVersion}
                  </Button>
                </div>
                {versionsLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : !versions || versions.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-center">
                    <p className="text-sm font-medium text-foreground">{wa.versions.empty}</p>
                    <p className="text-xs text-muted-foreground mt-1">{wa.versions.emptyDescription}</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{wa.versions.columnVersion}</TableHead>
                        <TableHead>{wa.versions.columnStatus}</TableHead>
                        <TableHead>{wa.versions.columnSize}</TableHead>
                        <TableHead>{wa.versions.columnDate}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {versions.map((v) => (
                        <TableRow key={v.version}>
                          <TableCell className="font-medium">{v.version}</TableCell>
                          <TableCell className="capitalize">{v.status}</TableCell>
                          <TableCell>{formatBytes(v.bundleSize)}</TableCell>
                          <TableCell>{new Date(v.createdAt).toLocaleDateString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              {/* OAuth client */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">{wa.oauth.title}</h3>
                <p className="text-xs text-muted-foreground mb-2">{wa.oauth.description}</p>
                <div className="flex items-center gap-2">
                  <div className="flex-1 text-sm text-muted-foreground truncate">
                    {oauthClient?.clientId ? (
                      <span className="font-mono">{oauthClient.clientId}</span>
                    ) : (
                      wa.oauth.noClient
                    )}
                  </div>
                  {canDevelop && (
                    <Button size="sm" variant="outline" onClick={handleCreateOauth} disabled={createOauthMutation.isPending}>
                      {createOauthMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {oauthClient?.clientId ? wa.oauth.rotate : wa.oauth.create}
                    </Button>
                  )}
                </div>
              </div>

              {/* Delete */}
              {canDevelop && (
                <div className="pt-4 border-t border-border">
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive gap-2" onClick={() => setDeleteOpen(true)}>
                    <Trash2 className="h-4 w-4" />
                    {wa.manage.deleteApp}
                  </Button>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {app && (
        <>
          <UploadVersionDialog open={uploadOpen} onOpenChange={setUploadOpen} app={app} />

          <Dialog open={submitOpen} onOpenChange={submitMutation.isPending ? undefined : setSubmitOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{format(wa.submit.dialogTitle, { name: app.name })}</DialogTitle>
                <DialogDescription>{wa.submit.dialogDescription}</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label>{wa.submit.notesLabel}</Label>
                <Textarea
                  value={submitNotes}
                  onChange={(e) => setSubmitNotes(e.target.value)}
                  placeholder={wa.submit.notesPlaceholder}
                  rows={4}
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSubmitOpen(false)} disabled={submitMutation.isPending}>
                  {wa.consent.cancel}
                </Button>
                <Button type="button" onClick={handleSubmit} disabled={submitMutation.isPending}>
                  {submitMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {wa.submit.submit}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={format(wa.manage.deleteTitle, { name: app.name })}
            description={wa.manage.deleteDescription}
            confirmLabel={wa.manage.deleteApp}
            variant="destructive"
            onConfirm={handleDelete}
          />

          <UserAppConsentDialog
            open={installConsentOpen}
            onOpenChange={setInstallConsentOpen}
            appName={app.name}
            scopes={app.requestedScopes}
            mode="install"
            onConfirm={handleInstall}
          />
        </>
      )}

      {/* Secret shown once — separate from the Sheet so it survives the Sheet closing. */}
      <Dialog open={!!newOauthSecret} onOpenChange={(o) => !o && setNewOauthSecret(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{wa.oauth.secretWarningTitle}</DialogTitle>
            <DialogDescription>{wa.oauth.secretWarning}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="mb-1.5 block">{wa.oauth.clientIdLabel}</Label>
              <code className="block w-full rounded-md border border-border bg-muted px-3 py-2 text-xs font-mono truncate">
                {newOauthSecret?.clientId}
              </code>
            </div>
            <div>
              <Label className="mb-1.5 block">{wa.oauth.secretLabel}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-xs font-mono truncate">
                  {newOauthSecret?.clientSecret}
                </code>
                <Button type="button" size="sm" variant="outline" onClick={handleCopySecret} className="gap-1.5 shrink-0">
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? wa.oauth.copied : wa.oauth.copy}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setNewOauthSecret(null)}>{wa.oauth.done}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
