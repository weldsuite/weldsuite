/**
 * One line of bank feed status above the bank accounts list: how many banks
 * are connected, when they last synced, and whether one needs attention, with
 * a link to the bank feeds page for the rest. Without a connection it offers
 * Connect bank instead, as long as there are accounts it could feed (with no
 * accounts at all, the list's empty state makes that offer).
 */
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ChevronRight, Landmark } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { useBankFeedConnections, useBankFeedProviders } from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import type { BankFeedConnection } from '@/lib/api/domains/weldbooks-bank-feeds';
import { ConnectBankButton } from './connect-bank-button';
import { formatRelativeTime, isEnded, needsReauth, FEEDS_PATH } from './feed-utils';
import { useFeedTexts } from './feed-texts';

const STRIP_CLASS = 'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-2.5 text-sm';

/** The most recent sync of any of `connections`, or null when none has synced. */
export function latestSync(connections: BankFeedConnection[]): string | null {
  let latest: string | null = null;
  for (const connection of connections) {
    if (!connection.lastSyncedAt) continue;
    if (!latest || new Date(connection.lastSyncedAt) > new Date(latest)) latest = connection.lastSyncedAt;
  }
  return latest;
}

export function BankFeedsStrip({ hasAccounts }: Readonly<{ hasAccounts: boolean }>) {
  const { t, format, plural, language } = useFeedTexts();
  const { can } = usePermissions();
  const readable = can('banking:read');
  const connections = useBankFeedConnections({ enabled: readable });
  const providers = useBankFeedProviders(undefined, { enabled: readable });

  // The bank feeds page reports load errors; a summary line just stays away.
  if (!readable || connections.isLoading || connections.isError) return null;

  const live = (connections.data ?? []).filter((connection) => !isEnded(connection.status));

  if (live.length === 0) {
    const canConnect = can('banking:create') && (providers.data?.providers.length ?? 0) > 0;
    if (!hasAccounts || !canConnect) return null;
    return (
      <section aria-label={t.strip.label} className={STRIP_CLASS}>
        <Landmark className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-[12rem] flex-1 text-muted-foreground">{t.strip.connectPrompt}</p>
        <ConnectBankButton variant="outline" size="sm" />
      </section>
    );
  }

  const synced = latestSync(live);
  const attention = live.filter((c) => needsReauth(c.status) || c.status === 'error').length;

  return (
    <section aria-label={t.strip.label} className={STRIP_CLASS}>
      <Landmark className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{plural(live.length, t.strip.connected)}</span>
        <span className="text-muted-foreground">
          {' · '}
          {synced ? format(t.strip.synced, { time: formatRelativeTime(synced, language) }) : t.strip.neverSynced}
        </span>
      </p>
      {attention > 0 ? (
        <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-4" aria-hidden="true" />
          {plural(attention, t.strip.attention)}
        </span>
      ) : null}
      <Button asChild variant="ghost" size="sm" className="-mr-2">
        <Link to={FEEDS_PATH}>
          {t.strip.manage}
          <ChevronRight aria-hidden="true" />
        </Link>
      </Button>
    </section>
  );
}
