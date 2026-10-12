/**
 * What the app detail page shows instead of "Install" for an app that is on
 * request only: the request button, or the state of the request (pending,
 * rejected with its reason, suspended with its reason).
 */

import { useState } from 'react';
import { Clock, ShieldAlert, XCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import type { AppAccessView } from '@weldsuite/app-api-client/schemas/reach';
import { SoftBadge } from '@/components/shared/soft-badge';
import { useReachFormat } from '@/lib/reach/format';
import { AppAccessRequestDialog } from './app-access-request-dialog';
import { accessBadgeTone, canRequestAccess, type AppAccessState } from './app-access-state';

interface AppAccessControlsProps {
  app: { code: string; name: string };
  status: AppAccessState;
  /** The workspace's request, when it has one; carries the staff-written reasons. */
  view?: AppAccessView | null;
  /** Owners and admins only. */
  canManage: boolean;
  onRequested?: () => void;
}

export function AppAccessControls({ app, status, view, canManage, onRequested }: Readonly<AppAccessControlsProps>) {
  const t = useTranslations();
  const format = useReachFormat();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="flex max-w-72 flex-col items-end gap-2 text-right">
      {status !== 'none' && (
        <SoftBadge tone={status === 'rejected' ? 'danger' : accessBadgeTone(status)}>
          {t(`reach.access.status.${status}`)}
        </SoftBadge>
      )}

      {status === 'requested' && (
        <>
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('reach.accessUi.pendingInStore')}</span>
          </p>
          {view?.requestedAt && (
            <p className="text-xs text-muted-foreground">
              {t('reach.accessUi.requestedOn', { date: format.date(view.requestedAt) })}
            </p>
          )}
        </>
      )}

      {status === 'rejected' && (
        <div className="space-y-1 text-sm">
          <p className="flex items-start justify-end gap-1.5 font-medium">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{t('reach.access.rejectedTitle')}</span>
          </p>
          {view?.rejectionReason && (
            <p className="text-muted-foreground">
              {t('reach.access.reason')}: {view.rejectionReason}
            </p>
          )}
          <p className="text-muted-foreground">{t('reach.access.rejectedDescription')}</p>
        </div>
      )}

      {(status === 'suspended' || status === 'revoked') && (
        <div className="space-y-1 text-sm">
          <p className="flex items-start justify-end gap-1.5 font-medium">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>
              {status === 'suspended' ? t('reach.access.suspendedTitle') : t('reach.shell.blocked.revokedTitle')}
            </span>
          </p>
          {view?.suspendedReason && (
            <p className="text-muted-foreground">
              {t('reach.access.reason')}: {view.suspendedReason}
            </p>
          )}
          <p className="text-muted-foreground">
            {status === 'suspended' ? t('reach.access.suspendedDescription') : t('reach.shell.blocked.revokedDescription')}
          </p>
        </div>
      )}

      {canRequestAccess(status) &&
        (canManage ? (
          <Button onClick={() => setDialogOpen(true)}>
            {status === 'rejected' ? t('reach.access.requestAgain') : t('reach.access.requestAccess')}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{t('reach.access.onlyAdmins')}</p>
        ))}

      <AppAccessRequestDialog app={app} open={dialogOpen} onOpenChange={setDialogOpen} onSubmitted={onRequested} />
    </div>
  );
}
