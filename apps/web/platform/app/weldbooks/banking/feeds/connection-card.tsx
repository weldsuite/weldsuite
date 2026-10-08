import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Landmark,
  Link2,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Unlink,
  Trash2,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useBankFeedProviders,
  useDeleteBankFeed,
  useDisconnectBankFeed,
} from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import type { BankFeedConnection } from '@/lib/api/domains/weldbooks-bank-feeds';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { AccountMappingDialog } from './account-mapping-dialog';
import { ConnectBankButton } from './connect-bank-button';
import { ConnectionStatusBadge } from './connection-status-badge';
import { describeFeedError, feedErrorText } from './describe-error';
import {
  canSyncNow,
  daysUntil,
  formatRelativeTime,
  isEnded,
  unmappedAccounts,
} from './feed-utils';
import { useFeedTexts } from './feed-texts';
import { PendingTransactions } from './pending-transactions';
import { useSyncFeedAction } from './use-sync-feed-action';
import { repairRequest, useBankFeedConnect } from './use-bank-feed-connect';

const WARNING_BOX =
  'border-amber-500/40 bg-amber-500/5 text-amber-900 dark:border-amber-400/30 dark:text-amber-200 *:data-[slot=alert-description]:text-amber-900/80 dark:*:data-[slot=alert-description]:text-amber-200/80';

/** One bank connection: its health, accounts, pending transactions and the actions that repair or end it. */
export function ConnectionCard({ connection }: Readonly<{ connection: BankFeedConnection }>) {
  const { t, format, plural, language, providerName } = useFeedTexts();
  const { formatDate, formatDateTime } = useWeldbooksFormat();
  const { can } = usePermissions();
  const canCreate = can('banking:create');
  const canUpdate = can('banking:update');
  const canManage = can('banking:manage');

  const providers = useBankFeedProviders();
  const sync = useSyncFeedAction(connection.id);
  const disconnect = useDisconnectBankFeed();
  const remove = useDeleteBankFeed();
  const flow = useBankFeedConnect();

  const [confirm, setConfirm] = useState<'disconnect' | 'remove' | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [warningsOpen, setWarningsOpen] = useState(false);

  const bank = connection.institutionName ?? t.connection.unknownBank;
  const unlinked = unmappedAccounts(connection);
  const syncable = canSyncNow(connection) && canUpdate;
  const refreshable = syncable && connection.capabilities?.onDemandRefresh === true;
  const ended = isEnded(connection.status);
  const supportsPending = connection.capabilities?.pendingTransactions !== false;
  const hasMapped = connection.accounts.length > unlinked.length;
  const warnings = [...connection.warnings].reverse();

  const addAccounts = () => {
    const request = repairRequest(connection, 'add_accounts', providers.data);
    if (request) void flow.connect(request);
  };

  const confirmDisconnect = async () => {
    try {
      await disconnect.mutateAsync(connection.id);
      toast.success(format(t.disconnect.done, { bank }));
      setConfirm(null);
    } catch (err) {
      toast.error(feedErrorText(describeFeedError(err, t), t, format));
    }
  };

  const confirmRemove = async () => {
    try {
      await remove.mutateAsync(connection.id);
      toast.success(format(t.remove.done, { bank }));
      setConfirm(null);
    } catch (err) {
      toast.error(feedErrorText(describeFeedError(err, t), t, format));
    }
  };

  const lastSynced = connection.lastSyncedAt
    ? format(t.connection.lastSynced, { time: formatRelativeTime(connection.lastSyncedAt, language) })
    : t.connection.neverSynced;

  const banner = statusBanner();

  function statusBanner(): ReactNode {
    switch (connection.status) {
      case 'reauth_required':
        return (
          <Alert className={WARNING_BOX}>
            <AlertTriangle />
            <AlertTitle>{t.banners.reauthTitle}</AlertTitle>
            <AlertDescription>
              <p>{format(t.banners.reauthBody, { bank })}</p>
              <ConnectBankButton mode="reauth" connection={connection} label={t.actions.reconnect} size="sm" />
            </AlertDescription>
          </Alert>
        );
      case 'expiring': {
        const days = connection.consentExpiresAt ? daysUntil(connection.consentExpiresAt) : null;
        return (
          <Alert className={WARNING_BOX}>
            <AlertTriangle />
            <AlertTitle>{t.banners.expiringTitle}</AlertTitle>
            <AlertDescription>
              <p>
                {days !== null && days > 0
                  ? format(plural(days, t.banners.expiringBody), { bank })
                  : format(t.banners.expiringToday, { bank })}
              </p>
              <ConnectBankButton mode="reauth" connection={connection} label={t.actions.renew} size="sm" />
            </AlertDescription>
          </Alert>
        );
      }
      case 'revoked':
      case 'disconnected':
        return (
          <Alert>
            <Unlink />
            <AlertTitle>
              {connection.status === 'revoked' ? t.banners.revokedTitle : t.banners.disconnectedTitle}
            </AlertTitle>
            <AlertDescription>
              <p>
                {format(connection.status === 'revoked' ? t.banners.revokedBody : t.banners.disconnectedBody, {
                  bank,
                })}
              </p>
              <ConnectBankButton label={t.actions.connectAgain} size="sm" />
            </AlertDescription>
          </Alert>
        );
      case 'error':
        return (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t.banners.errorTitle}</AlertTitle>
            <AlertDescription>
              <p>{t.banners.errorBody}</p>
              {connection.lastError ? (
                <p className="text-xs">{format(t.banners.errorDetail, { error: connection.lastError })}</p>
              ) : null}
              <ConnectBankButton
                mode="reauth"
                connection={connection}
                label={t.actions.reconnect}
                size="sm"
                variant="outline"
              />
            </AlertDescription>
          </Alert>
        );
      default:
        return null;
    }
  }

  return (
    <section aria-label={bank} className="space-y-4 rounded-lg border bg-card p-4 text-card-foreground">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <Landmark className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-base font-semibold">{bank}</h3>
              <ConnectionStatusBadge status={connection.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              {format(t.connection.via, { provider: providerName(connection.provider) })} · {lastSynced}
              {connection.consentExpiresAt && !ended
                ? ` · ${format(t.connection.accessEnds, { date: formatDate(connection.consentExpiresAt) })}`
                : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {syncable ? (
            <Button type="button" variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.run(false)}>
              {sync.isPending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              {sync.isPending ? t.actions.syncing : t.actions.syncNow}
            </Button>
          ) : null}

          {(refreshable || (canCreate && !ended) || canManage) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t.actions.moreActions}>
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {refreshable ? (
                  <DropdownMenuItem disabled={sync.isPending} onSelect={() => sync.run(true)}>
                    <RefreshCw aria-hidden="true" />
                    {t.actions.refreshAndSync}
                  </DropdownMenuItem>
                ) : null}
                {canCreate && !ended ? (
                  <DropdownMenuItem disabled={flow.busy || !providers.data} onSelect={addAccounts}>
                    <Plus aria-hidden="true" />
                    {t.actions.addAccounts}
                  </DropdownMenuItem>
                ) : null}
                {canManage ? (
                  <>
                    {(refreshable || (canCreate && !ended)) && <DropdownMenuSeparator />}
                    {connection.status !== 'disconnected' ? (
                      <DropdownMenuItem onSelect={() => setConfirm('disconnect')}>
                        <Unlink aria-hidden="true" />
                        {t.actions.disconnect}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem variant="destructive" onSelect={() => setConfirm('remove')}>
                      <Trash2 aria-hidden="true" />
                      {t.actions.remove}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {banner}

      {connection.accounts.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">{t.connection.accountsHeading}</h4>
          <ul className="divide-y rounded-md border">
            {connection.accounts.map((account) => (
              <li
                key={account.feedAccountId}
                className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-medium">{account.name}</span>
                    {account.mask ? (
                      <span className="text-sm text-muted-foreground">••{account.mask}</span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {t.connection.accountTypes[account.type]} · {account.currency}
                    </span>
                    {account.status !== 'active' && account.status !== connection.status ? (
                      <ConnectionStatusBadge status={account.status} />
                    ) : null}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground sm:text-right">
                  {account.bankAccountId ? (
                    <>
                      <span className="text-foreground">
                        {format(t.connection.linkedTo, { name: account.bankAccountName ?? '' })}
                      </span>
                      <span className="block text-xs">
                        {account.syncFrom
                          ? format(t.connection.importsFrom, { date: formatDate(account.syncFrom) })
                          : t.connection.importsAll}
                      </span>
                    </>
                  ) : (
                    <Badge variant="outline">{t.connection.notLinked}</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {unlinked.length > 0 && canUpdate && !ended ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
              <p className="text-sm text-muted-foreground">{plural(unlinked.length, t.connection.unlinkedNote)}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setMappingOpen(true)}>
                <Link2 aria-hidden="true" />
                {t.actions.linkAccounts}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {supportsPending && hasMapped ? (
        <div className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2"
            aria-expanded={pendingOpen}
            onClick={() => setPendingOpen((open) => !open)}
          >
            {pendingOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            {pendingOpen ? t.actions.hidePending : t.actions.pendingTransactions}
          </Button>
          {pendingOpen ? <PendingTransactions connectionId={connection.id} /> : null}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2"
            aria-expanded={warningsOpen}
            onClick={() => setWarningsOpen((open) => !open)}
          >
            {warningsOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            {t.actions.warnings}
            <Badge variant="secondary">{warnings.length}</Badge>
          </Button>
          {warningsOpen ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t.warnings.description}</p>
              <ul className="space-y-1 rounded-md border p-2 text-sm">
                {warnings.map((warning, index) => (
                  <li key={`${warning.at}-${warning.code}-${index}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                    <time className="shrink-0 text-xs text-muted-foreground sm:w-40" dateTime={warning.at}>
                      {formatDateTime(warning.at)}
                    </time>
                    <span>{warning.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm === 'disconnect'}
        onOpenChange={(open) => setConfirm(open ? 'disconnect' : null)}
        title={format(t.disconnect.title, { bank })}
        description={t.disconnect.description}
        confirmLabel={t.disconnect.confirm}
        cancelLabel={t.connect.cancel}
        variant="destructive"
        onConfirm={confirmDisconnect}
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        onOpenChange={(open) => setConfirm(open ? 'remove' : null)}
        title={format(t.remove.title, { bank })}
        description={t.remove.description}
        confirmLabel={t.remove.confirm}
        cancelLabel={t.connect.cancel}
        variant="destructive"
        onConfirm={confirmRemove}
      />
      {mappingOpen ? (
        <AccountMappingDialog open onOpenChange={setMappingOpen} connection={connection} />
      ) : null}
      {flow.dialogs}
    </section>
  );
}
