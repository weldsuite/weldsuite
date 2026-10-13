/**
 * The gate inside the WeldReach shell.
 *
 * Every reach-api route answers 403 APP_ACCESS_REQUIRED until WeldSuite staff
 * approve the workspace, and again after a suspension. This boundary asks
 * `GET /api/reach/access` first: while that is refused it renders the
 * explanation (pending, rejected, suspended, revoked) instead of the page, and
 * once it succeeds it shows a slim header with usage against the limits plus a
 * banner when sending is switched off. A suspension that lands while the module
 * is open is picked up on the next refetch, or immediately when any other
 * reach query is refused with the same code.
 */

import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Clock, XCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useTranslations } from '@weldsuite/i18n/client';
import type { AppAccessStatus, ReachAccessSummary } from '@weldsuite/app-api-client/schemas/reach';
import { PageLoader } from '@/components/page-loader';
import { Link } from '@/lib/router';
import { useAppAccessRequest } from '@/hooks/queries/use-app-access-queries';
import { reachKeys, useReachAccess } from '@/hooks/queries/use-reach-queries';
import { appAccessRequiredStatus, isAppAccessRequiredError } from '@/lib/reach/errors';
import { useReachFormat } from '@/lib/reach/format';
import { ErrorPanel } from './page-kit';

export function ReachAccessBoundary({ children }: Readonly<{ children: ReactNode }>) {
  const t = useTranslations();
  const qc = useQueryClient();
  const access = useReachAccess();

  // Any reach query refused with APP_ACCESS_REQUIRED re-checks access, so the
  // screen flips as soon as a suspension lands instead of showing an error per card.
  useEffect(() => {
    return qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      const [root, kind] = event.query.queryKey;
      if (root !== 'reach' || kind === 'access') return;
      if (isAppAccessRequiredError(event.action.error)) {
        void qc.invalidateQueries({ queryKey: reachKeys.access() });
      }
    });
  }, [qc]);

  if (access.error && isAppAccessRequiredError(access.error)) {
    return <ReachAccessBlocked status={appAccessRequiredStatus(access.error) ?? 'none'} />;
  }
  if (access.isPending) {
    return <PageLoader fullScreen={false} label={t('reach.common.loading')} />;
  }
  if (!access.data) {
    return (
      <div className="p-6">
        <ErrorPanel message={t('reach.shell.accessError.description')} onRetry={() => void access.refetch()} />
      </div>
    );
  }

  return (
    <>
      <ReachStatusStrip summary={access.data} />
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Usage header and kill-switch banner
// ---------------------------------------------------------------------------

function UsageItem({ label, used, limit }: Readonly<{ label: string; used: number; limit: number }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const full = limit > 0 && used >= limit;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span>{label}</span>
      <span className={full ? 'font-medium text-amber-600 dark:text-amber-400' : 'font-medium text-foreground'}>
        {t('reach.shell.usageValue', { used: format.number(used), limit: format.number(limit) })}
      </span>
    </span>
  );
}

export function ReachStatusStrip({ summary }: Readonly<{ summary: ReachAccessSummary }>) {
  const t = useTranslations();
  const { usage, limits } = summary;

  return (
    <>
      {!summary.sendingEnabled && (
        <InfoBanner variant="warning" title={t('reach.shell.sendingOff.title')} className="rounded-none border-x-0 border-t-0">
          {t('reach.shell.sendingOff.description')}
        </InfoBanner>
      )}
      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground"
        aria-label={t('reach.title')}
      >
        <UsageItem label={t('reach.shell.usage.mailboxes')} used={usage.mailboxes} limit={limits.maxMailboxes} />
        <UsageItem label={t('reach.shell.usage.domains')} used={usage.domains} limit={limits.maxDomains} />
        <UsageItem label={t('reach.shell.usage.sendsToday')} used={usage.sendsToday} limit={limits.maxDailySends} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Blocked: pending, rejected, suspended, revoked
// ---------------------------------------------------------------------------

export function ReachAccessBlocked({ status }: Readonly<{ status: AppAccessStatus | 'none' }>) {
  const t = useTranslations();
  // The staff-written reason lives in app-api, which stays reachable.
  const request = useAppAccessRequest('weldreach');
  const view = request.data;
  const reason = status === 'rejected' ? view?.rejectionReason : view?.suspendedReason;

  let Icon = ShieldAlert;
  let title = t('reach.shell.blocked.noneTitle');
  let description = t('reach.shell.blocked.noneDescription');
  if (status === 'requested') {
    Icon = Clock;
    title = t('reach.access.pendingTitle');
    description = t('reach.access.pendingDescription');
  } else if (status === 'rejected') {
    Icon = XCircle;
    title = t('reach.access.rejectedTitle');
    description = t('reach.access.rejectedDescription');
  } else if (status === 'suspended') {
    title = t('reach.access.suspendedTitle');
    description = t('reach.access.suspendedDescription');
  } else if (status === 'revoked') {
    title = t('reach.shell.blocked.revokedTitle');
    description = t('reach.shell.blocked.revokedDescription');
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="mb-2 text-lg font-semibold">{title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        {reason && (
          <p className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">{t('reach.access.reason')}:</span> {reason}
          </p>
        )}
        <Button asChild variant="outline" className="mt-5">
          <Link href="/appstore/weldreach">
            {status === 'none' ? t('reach.shell.blocked.openAppStore') : t('reach.shell.blocked.viewRequest')}
          </Link>
        </Button>
      </div>
    </div>
  );
}
