/** Workforce portal access card for the employee detail page. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RotateCcw, Send, UserX } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useHrPortalAccess,
  useHrPortalSettings,
  useInviteHrPortalAccess,
  useRevokeHrPortalAccess,
  useRestoreHrPortalAccess,
} from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, StatusBadge, errorMessage, formatDate, formatDateTime } from '../shared';
import { EmptyText, SectionCard } from '../page-kit';

type PortalAccess = NonNullable<ReturnType<typeof useHrPortalAccess>['data']>[number];

type PortalCardBodyProps = Readonly<{
  isLoading: boolean;
  error: unknown;
  isTerminated: boolean;
  access: PortalAccess | null;
  portalEnabled: boolean;
  pending: boolean;
  onInvite: () => void;
  onRevoke: () => void;
  onRestore: () => void;
}>;

function PortalCardBody({
  isLoading,
  error,
  isTerminated,
  access,
  portalEnabled,
  pending,
  onInvite,
  onRevoke,
  onRestore,
}: PortalCardBodyProps) {
  const t = useTranslations();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) return <ErrorBanner error={errorMessage(error, t('weldhr.common.loadFailed'))} />;
  if (isTerminated) return <EmptyText>{t('weldhr.portal.employeeCard.terminatedHint')}</EmptyText>;
  if (!access) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('weldhr.portal.employeeCard.noAccess')}</p>
        {!portalEnabled && (
          <p className="text-xs text-amber-600 dark:text-amber-400">{t('weldhr.portal.access.portalDisabledNotice')}</p>
        )}
        <Button size="sm" onClick={onInvite} disabled={pending}>
          {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
          {t('weldhr.portal.employeeCard.invite')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <StatusBadge group="portalAccess" status={access.status} />
        <span className="text-xs text-muted-foreground">
          {t('weldhr.portal.access.invitedAt')}: {formatDate(access.invitedAt)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('weldhr.portal.access.lastSignIn')}: {formatDateTime(access.lastLoginAt)}
      </p>
      <div className="flex flex-wrap gap-2">
        {access.status === 'revoked' ? (
          <Button size="sm" variant="outline" onClick={onRestore} disabled={pending}>
            <RotateCcw className="mr-1.5 h-4 w-4" />
            {t('weldhr.portal.access.restore')}
          </Button>
        ) : (
          <>
            {access.status === 'invited' && (
              <Button size="sm" variant="outline" onClick={onInvite} disabled={pending}>
                <Send className="mr-1.5 h-4 w-4" />
                {t('weldhr.portal.employeeCard.resend')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onRevoke} disabled={pending}>
              <UserX className="mr-1.5 h-4 w-4" />
              {t('weldhr.portal.access.revoke')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function EmployeePortalAccessCard({ employeeId, employeeStatus }: Readonly<{ employeeId: string; employeeStatus: string }>) {
  const t = useTranslations();
  const settings = useHrPortalSettings();
  const { data, isLoading, error } = useHrPortalAccess({ kind: 'employee', employeeId });
  const invite = useInviteHrPortalAccess();
  const revoke = useRevokeHrPortalAccess();
  const restore = useRestoreHrPortalAccess();
  const [failure, setFailure] = useState<string | null>(null);

  const access = data?.[0] ?? null;
  const isTerminated = employeeStatus === 'terminated';
  const pending = invite.isPending || revoke.isPending || restore.isPending;

  async function handleInvite() {
    setFailure(null);
    try {
      const result = await invite.mutateAsync({ kind: 'employee', employeeId });
      toast.success(
        result.data.emailed
          ? t('weldhr.portal.employeeCard.invited')
          : t('weldhr.portal.employeeCard.invitedNoEmail'),
      );
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.portal.access.inviteFailed')));
    }
  }

  async function handleRevoke() {
    if (!access) return;
    setFailure(null);
    try {
      await revoke.mutateAsync(access.id);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.portal.access.revokeFailed')));
    }
  }

  async function handleRestore() {
    if (!access) return;
    setFailure(null);
    try {
      await restore.mutateAsync(access.id);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.portal.access.restoreFailed')));
    }
  }

  return (
    <SectionCard title={t('weldhr.portal.employeeCard.title')} contentClassName="space-y-3">
        <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

        <PortalCardBody
          isLoading={isLoading}
          error={error}
          isTerminated={isTerminated}
          access={access}
          portalEnabled={!!settings.data?.isEnabled}
          pending={pending}
          onInvite={() => void handleInvite()}
          onRevoke={() => void handleRevoke()}
          onRestore={() => void handleRestore()}
        />
    </SectionCard>
  );
}
