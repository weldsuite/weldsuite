/**
 * Bank feeds for the banking pages (Plaid, Stripe Financial Connections,
 * Ponto, Enable Banking).
 *
 * - Without `bankAccountId`: the connections overview, with Connect bank.
 * - With `bankAccountId`: the feed status of that one bank account (connected
 *   through which bank, last synced, re-auth needed, pending count, sync now),
 *   or a prompt to connect one.
 */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Landmark, Loader2, RefreshCw } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  useBankFeedConnections,
  useBankFeedPendingTransactions,
  useBankFeedProviders,
} from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import type { BankFeedAccount, BankFeedConnection } from '@/lib/api/domains/weldbooks-bank-feeds';
import { ConnectBankButton } from './connect-bank-button';
import { ConnectionCard } from './connection-card';
import { ConnectionStatusBadge } from './connection-status-badge';
import { canSyncNow, daysUntil, formatRelativeTime, isEnded, needsReauth, FEEDS_PATH } from './feed-utils';
import { useFeedTexts } from './feed-texts';
import { PendingTransactions } from './pending-transactions';
import { useSyncFeedAction } from './use-sync-feed-action';

export function BankFeedsPanel({ bankAccountId }: Readonly<{ bankAccountId?: string }>) {
  const { can } = usePermissions();
  if (!can('banking:read')) return null;
  return bankAccountId ? <AccountFeedStatus bankAccountId={bankAccountId} /> : <ConnectionsOverview />;
}

// ============================================================================
// Overview
// ============================================================================

function ConnectionsOverview() {
  const { t, format } = useFeedTexts();
  const connections = useBankFeedConnections();
  const providers = useBankFeedProviders();
  const list = connections.data ?? [];
  const noProviders = providers.isSuccess && providers.data.providers.length === 0;

  return (
    <section aria-labelledby="bank-feeds-title" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="bank-feeds-title" className="text-lg font-semibold">
            {t.title}
          </h2>
          <p className="text-sm text-muted-foreground">{t.subtitle}</p>
        </div>
        <ConnectBankButton label={list.length > 0 ? t.connectAnotherBank : t.connectBank} />
      </header>

      {noProviders ? (
        <p className="text-sm text-muted-foreground">{format(t.list.noProviders, { country: providers.data.country })}</p>
      ) : providers.isError ? (
        <p className="text-sm text-muted-foreground">{t.list.providersLoadError}</p>
      ) : null}

      {connections.isLoading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : connections.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            <span>{t.list.loadError}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => connections.refetch()}>
              {t.list.retry}
            </Button>
          </AlertDescription>
        </Alert>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
          <Landmark className="size-8 text-muted-foreground/60" strokeWidth={1.5} aria-hidden="true" />
          <h3 className="font-medium">{t.list.emptyTitle}</h3>
          <p className="max-w-md text-sm text-muted-foreground">{t.list.emptyDescription}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} />
          ))}
        </div>
      )}
    </section>
  );
}

// ============================================================================
// One bank account
// ============================================================================

/** The connection feeding a bank account; a live one wins over an ended one that used to. */
export function findAccountFeed(
  connections: BankFeedConnection[],
  bankAccountId: string,
): { connection: BankFeedConnection; account: BankFeedAccount } | null {
  let found: { connection: BankFeedConnection; account: BankFeedAccount } | null = null;
  for (const connection of connections) {
    const account = connection.accounts.find((a) => a.bankAccountId === bankAccountId);
    if (!account) continue;
    if (!isEnded(connection.status)) return { connection, account };
    found ??= { connection, account };
  }
  return found;
}

function AccountFeedStatus({ bankAccountId }: Readonly<{ bankAccountId: string }>) {
  const { t } = useFeedTexts();
  const connections = useBankFeedConnections();

  const feed = useMemo(
    () => (connections.data ? findAccountFeed(connections.data, bankAccountId) : null),
    [connections.data, bankAccountId],
  );

  if (connections.isLoading) {
    return <Skeleton className="h-20 w-full" aria-busy="true" />;
  }

  if (connections.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <span>{t.list.loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => connections.refetch()}>
            {t.list.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!feed) {
    return (
      <section
        aria-label={t.account.feedStatusLabel}
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4"
      >
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{t.account.noFeedTitle}</h3>
          <p className="text-sm text-muted-foreground">{t.account.noFeedDescription}</p>
        </div>
        <div className="flex items-center gap-2">
          <ConnectBankButton label={t.account.connectFeed} variant="outline" defaultBankAccountId={bankAccountId} />
          <Button asChild variant="ghost" size="sm">
            <Link to={FEEDS_PATH}>{t.allFeeds}</Link>
          </Button>
        </div>
      </section>
    );
  }

  return <LinkedAccountFeed connection={feed.connection} bankAccountId={bankAccountId} />;
}

function LinkedAccountFeed({
  connection,
  bankAccountId,
}: Readonly<{ connection: BankFeedConnection; bankAccountId: string }>) {
  const { t, format, plural, language, providerName } = useFeedTexts();
  const { can } = usePermissions();
  const sync = useSyncFeedAction(connection.id);
  const [pendingOpen, setPendingOpen] = useState(false);

  const ended = isEnded(connection.status);
  const bank = connection.institutionName ?? t.connection.unknownBank;
  const showPending = connection.capabilities?.pendingTransactions !== false && !ended;
  const pending = useBankFeedPendingTransactions(connection.id, bankAccountId, { enabled: showPending });
  const pendingCount = pending.data?.length ?? 0;
  const lastSynced = connection.lastSyncedAt
    ? format(t.connection.lastSynced, { time: formatRelativeTime(connection.lastSyncedAt, language) })
    : t.connection.neverSynced;
  const expiresInDays =
    connection.status === 'expiring' && connection.consentExpiresAt ? daysUntil(connection.consentExpiresAt) : null;

  return (
    <section aria-label={t.account.feedStatusLabel} className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <Landmark className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">
                {format(t.account.connectedThrough, { bank })}
              </span>
              <ConnectionStatusBadge status={connection.status} />
            </div>
            <p className="text-xs text-muted-foreground">
              {providerName(connection.provider)} · {lastSynced}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {canSyncNow(connection) && can('banking:update') ? (
            <Button type="button" variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.run(false)}>
              {sync.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              {sync.isPending ? t.actions.syncing : t.actions.syncNow}
            </Button>
          ) : null}
          <Button asChild variant="ghost" size="sm">
            <Link to={FEEDS_PATH}>{t.account.manageFeed}</Link>
          </Button>
        </div>
      </div>

      {needsReauth(connection.status) ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/30 dark:text-amber-200">
          <span>
            {expiresInDays !== null && expiresInDays > 0
              ? format(plural(expiresInDays, t.banners.expiringBody), { bank })
              : connection.status === 'expiring'
                ? format(t.banners.expiringToday, { bank })
                : format(t.banners.reauthBody, { bank })}
          </span>
          <ConnectBankButton
            mode="reauth"
            connection={connection}
            label={connection.status === 'expiring' ? t.actions.renew : t.actions.reconnect}
            size="sm"
          />
        </div>
      ) : isEnded(connection.status) ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <span>
            {format(connection.status === 'revoked' ? t.banners.revokedBody : t.banners.disconnectedBody, { bank })}
          </span>
          <ConnectBankButton label={t.actions.connectAgain} size="sm" defaultBankAccountId={bankAccountId} />
        </div>
      ) : connection.status === 'error' ? (
        <p className="text-sm text-destructive">
          {t.banners.errorBody}
          {connection.lastError ? ` ${format(t.banners.errorDetail, { error: connection.lastError })}` : ''}
        </p>
      ) : null}

      {showPending ? (
        <div className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2"
            aria-expanded={pendingOpen}
            disabled={pending.isLoading || pendingCount === 0}
            onClick={() => setPendingOpen((open) => !open)}
          >
            {pendingOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            {pending.isLoading
              ? t.actions.pendingTransactions
              : pendingCount === 0
                ? t.pending.empty
                : plural(pendingCount, t.pending.count)}
          </Button>
          {pendingOpen && pendingCount > 0 ? (
            <PendingTransactions connectionId={connection.id} bankAccountId={bankAccountId} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
