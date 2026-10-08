/**
 * The connect flow, one place for every entry point (Connect bank, Reconnect,
 * Add accounts, the bank account page):
 *
 *   link-session -> provider launcher -> complete -> (account mapping)
 *
 * Whatever the provider, the launcher ends in the same payload, which goes to
 * `POST /bank-connections/complete`. Redirect flows leave the page between the
 * launcher and `complete`; the callback route picks the link up from there
 * and uses `useBankLinkOutcome` for what follows.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  useCompleteBankFeedLink,
  useCreateBankFeedLinkSession,
  useSyncBankFeed,
} from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import type {
  BankFeedConnection,
  BankFeedLinkMode,
  BankFeedProviderOption,
  BankFeedProviders,
} from '@/lib/api/domains/weldbooks-bank-feeds';
import { AccountMappingDialog } from './account-mapping-dialog';
import { describeFeedError, feedErrorText } from './describe-error';
import { bankFeedRedirectUrl, FEEDS_PATH, mappedAccounts, unmappedAccounts } from './feed-utils';
import { useFeedTexts } from './feed-texts';
import { launcherFor, safeReturnPath } from './launchers';
import { navigateAway } from './navigate-away';

export type ConnectPhase = 'idle' | 'starting' | 'launching' | 'completing';

export interface ConnectRequest {
  provider: BankFeedProviderOption;
  mode?: BankFeedLinkMode;
  /** Reconnect and add-accounts repair this connection. */
  connection?: BankFeedConnection;
  /** Providers that need the bank chosen up front (Enable Banking). */
  institution?: { id?: string; name: string; country: string };
  psuType?: 'business' | 'personal';
}

/**
 * The request that signs an existing connection in again (`reauth`) or adds
 * accounts to it, or null when its provider is not offered any more (not
 * configured).
 */
export function repairRequest(
  connection: BankFeedConnection,
  mode: Exclude<BankFeedLinkMode, 'create'>,
  providers: BankFeedProviders | undefined,
): ConnectRequest | null {
  const provider = providers?.providers.find((p) => p.id === connection.provider);
  if (!provider || !providers) return null;
  return {
    provider,
    mode,
    connection,
    // A redirect bank is chosen up front, and the connection already knows which one.
    institution:
      provider.requiresInstitution && connection.institutionName
        ? { id: connection.institutionId ?? undefined, name: connection.institutionName, country: providers.country }
        : undefined,
  };
}

/**
 * What happens once a link is complete: tell the user, start the first read
 * after a reconnect, and say whether the accounts still need mapping. The
 * mapping dialog itself is the caller's, since the callback route and the
 * button show it in different places.
 */
export function useBankLinkOutcome() {
  const { t, format } = useFeedTexts();
  const { can } = usePermissions();
  const sync = useSyncBankFeed();
  const { mutate: syncNow } = sync;

  return useCallback(
    (connection: BankFeedConnection, mode: BankFeedLinkMode): { needsMapping: boolean } => {
      const bank = connection.institutionName ?? t.connection.unknownBank;
      const canMap = can('banking:update');

      if (mode === 'reauth') {
        toast.success(format(t.connect.reconnected, { bank }));
        // The sync that was refused while the bank needed a sign-in: run it now.
        if (canMap && mappedAccounts(connection).length > 0) syncNow({ connectionId: connection.id });
        return { needsMapping: false };
      }

      toast.success(format(mode === 'create' ? t.connect.connected : t.connect.accountsAdded, { bank }));
      return { needsMapping: canMap && unmappedAccounts(connection).length > 0 };
    },
    [t, format, can, syncNow],
  );
}

export function useBankFeedConnect(
  options: {
    /** Bank account the user came from: offered to the first account without a better match. */
    defaultBankAccountId?: string;
    /** Where a redirect flow brings the user back to; defaults to the current page. */
    returnTo?: string;
    onLinked?: (connection: BankFeedConnection) => void;
  } = {},
): {
  connect: (request: ConnectRequest) => Promise<void>;
  phase: ConnectPhase;
  busy: boolean;
  /** Render this once, anywhere: it holds the account mapping dialog. */
  dialogs: ReactNode;
} {
  const { t, format } = useFeedTexts();
  const createSession = useCreateBankFeedLinkSession();
  const completeLink = useCompleteBankFeedLink();
  const outcome = useBankLinkOutcome();
  const [phase, setPhase] = useState<ConnectPhase>('idle');
  const [mapping, setMapping] = useState<BankFeedConnection | null>(null);
  const { mutateAsync: createAsync } = createSession;
  const { mutateAsync: completeAsync } = completeLink;
  const { defaultBankAccountId, returnTo: returnToOption, onLinked } = options;

  const connect = useCallback(
    async (request: ConnectRequest) => {
      if (phase !== 'idle') return;
      const mode = request.mode ?? 'create';
      const connectionId = mode === 'create' ? undefined : request.connection?.id;
      const redirectUrl = bankFeedRedirectUrl(window.location.origin);
      const returnTo = safeReturnPath(returnToOption ?? window.location.pathname, FEEDS_PATH);

      setPhase('starting');
      try {
        const session = await createAsync({
          provider: request.provider.id,
          mode,
          connectionId,
          redirectUrl,
          institution: request.institution,
          psuType: request.psuType,
        });

        setPhase('launching');
        const result = await launcherFor(session.kind)(session, {
          provider: request.provider.id,
          mode,
          connectionId,
          redirectUrl,
          returnTo,
          defaultBankAccountId,
          navigate: navigateAway,
        });
        // The browser is on its way to the bank; the callback route finishes the link.
        if (result.status === 'redirecting') return;
        if (result.status === 'cancelled') {
          setPhase('idle');
          return;
        }

        setPhase('completing');
        const done = await completeAsync({ provider: request.provider.id, payload: result.payload, connectionId });
        setPhase('idle');

        const { needsMapping } = outcome(done.connection, mode);
        if (needsMapping) setMapping(done.connection);
        onLinked?.(done.connection);
      } catch (err) {
        setPhase('idle');
        toast.error(feedErrorText(describeFeedError(err, t, 'link'), t, format));
      }
    },
    [phase, returnToOption, defaultBankAccountId, createAsync, completeAsync, outcome, onLinked, t, format],
  );

  const dialogs = mapping ? (
    <AccountMappingDialog
      open
      onOpenChange={(open) => {
        if (!open) setMapping(null);
      }}
      connection={mapping}
      defaultBankAccountId={defaultBankAccountId}
    />
  ) : null;

  return { connect, phase, busy: phase !== 'idle', dialogs };
}
