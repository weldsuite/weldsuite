/** Workforce portal access card for a CRM company's client detail page. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, RotateCcw, Trash2, UserX } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPortalAccess } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useHrPortalAccess,
  useHrPortalSettings,
  useInviteHrPortalAccess,
  useRevokeHrPortalAccess,
  useRestoreHrPortalAccess,
  useDeleteHrPortalAccess,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ErrorBanner, PersonPicker, StatusBadge, errorMessage, formatDate, formatDateTime } from '../shared';
import { EmptyText, SectionCard } from '../page-kit';

export function ClientPortalContactsCard({ companyId, companyName }: { companyId: string; companyName: string | null }) {
  const t = useTranslations();
  const { data, isLoading, error } = useHrPortalAccess({ kind: 'client', companyId });
  const [inviting, setInviting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<HrPortalAccess | null>(null);
  const revoke = useRevokeHrPortalAccess();
  const restore = useRestoreHrPortalAccess();
  const [rowFailure, setRowFailure] = useState<string | null>(null);

  async function handleRevoke(access: HrPortalAccess) {
    setRowFailure(null);
    try {
      await revoke.mutateAsync(access.id);
    } catch (err) {
      setRowFailure(errorMessage(err, t('weldhr.portal.access.revokeFailed')));
    }
  }

  async function handleRestore(access: HrPortalAccess) {
    setRowFailure(null);
    try {
      await restore.mutateAsync(access.id);
    } catch (err) {
      setRowFailure(errorMessage(err, t('weldhr.portal.access.restoreFailed')));
    }
  }

  return (
    <SectionCard
      title={t('weldhr.portal.clientCard.title')}
      action={
        <Button size="sm" variant="outline" onClick={() => setInviting(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t('weldhr.portal.access.inviteClientContact')}
        </Button>
      }
      contentClassName="space-y-3"
    >
        <ErrorBanner error={rowFailure} onDismiss={() => setRowFailure(null)} />

        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <ErrorBanner error={errorMessage(error, t('weldhr.common.loadFailed'))} />
        ) : !data || data.length === 0 ? (
          <EmptyText>{t('weldhr.portal.clientCard.emptyDescription')}</EmptyText>
        ) : (
          <div className="space-y-2">
            {data.map((access) => (
              <div key={access.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{access.displayName ?? access.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{access.email}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('weldhr.portal.access.lastSignIn')}: {formatDateTime(access.lastLoginAt)} · {t('weldhr.portal.access.invitedAt')}:{' '}
                    {formatDate(access.invitedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge group="portalAccess" status={access.status} />
                  {access.status === 'revoked' ? (
                    <Button variant="ghost" size="icon" className="h-7 w-7" title={t('weldhr.portal.access.restore')} onClick={() => void handleRestore(access)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button variant="ghost" size="icon" className="h-7 w-7" title={t('weldhr.portal.access.revoke')} onClick={() => void handleRevoke(access)}>
                      <UserX className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    title={t('weldhr.common.delete')}
                    onClick={() => setDeleteTarget(access)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

      {inviting && <InviteContactDialog companyId={companyId} companyName={companyName} onClose={() => setInviting(false)} />}
      {deleteTarget && <DeleteContactAccessDialog access={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </SectionCard>
  );
}

function InviteContactDialog({
  companyId,
  companyName,
  onClose,
}: {
  companyId: string;
  companyName: string | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const invite = useInviteHrPortalAccess();
  const settings = useHrPortalSettings();
  const [personId, setPersonId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    if (!personId) return;
    setFailure(null);
    try {
      const result = await invite.mutateAsync({ kind: 'client', personId, companyId });
      toast.success(result.data.emailed ? t('weldhr.portal.employeeCard.invited') : t('weldhr.portal.employeeCard.invitedNoEmail'));
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.portal.access.inviteFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldhr.portal.access.inviteClientContact')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <ErrorBanner error={failure} />
          {companyName && <p className="text-sm text-muted-foreground">{companyName}</p>}
          {!settings.data?.isEnabled && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {t('weldhr.portal.access.portalDisabledNotice')}
            </p>
          )}
          <PersonPicker companyId={companyId} value={personId} onChange={(id) => setPersonId(id)} />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={invite.isPending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={invite.isPending || !personId}>
            {invite.isPending ? t('weldhr.common.saving') : t('weldhr.portal.access.invite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteContactAccessDialog({ access, onClose }: { access: HrPortalAccess; onClose: () => void }) {
  const t = useTranslations();
  const deleteAccess = useDeleteHrPortalAccess();
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('weldhr.portal.access.deleteTitle')}
        description={t('weldhr.portal.access.deleteDescription', { name: access.displayName ?? access.email })}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        onConfirm={async () => {
          try {
            await deleteAccess.mutateAsync(access.id);
            onClose();
          } catch (err) {
            setFailure(errorMessage(err, t('weldhr.common.deleteFailed')));
          }
        }}
      />
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
    </>
  );
}
