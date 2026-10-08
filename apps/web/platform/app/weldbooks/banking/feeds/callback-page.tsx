/**
 * Where a bank sends the browser back to: Ponto and Enable Banking after the
 * bank sign-in (`code` and `state` in the URL), Plaid after an OAuth bank
 * (`oauth_state_id`, Link is re-opened to finish). The link that was started
 * is found in sessionStorage; this page completes it with the same payload the
 * in-page launchers produce, then shows the account mapping.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { useCompleteBankFeedLink } from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import type { BankFeedCompletePayload, BankFeedConnection } from '@/lib/api/domains/weldbooks-bank-feeds';
import { redirectPayload } from './callback-payload';
import { AccountMappingDialog } from './account-mapping-dialog';
import { describeFeedError, type FeedErrorMessage } from './describe-error';
import { FEEDS_PATH } from './feed-utils';
import { useFeedTexts } from './feed-texts';
import { clearPendingLink, readPendingLink, resumePlaidOAuth, safeReturnPath } from './launchers';
import { useBankLinkOutcome } from './use-bank-feed-connect';

type CallbackState =
  | { phase: 'processing' }
  | { phase: 'error'; error: FeedErrorMessage }
  | { phase: 'mapping'; connection: BankFeedConnection };

export default function BankFeedsCallbackPage() {
  const { t, format } = useFeedTexts();
  const router = useRouter();
  const completeLink = useCompleteBankFeedLink();
  const outcome = useBankLinkOutcome();
  const [state, setState] = useState<CallbackState>({ phase: 'processing' });
  const [returnTo, setReturnTo] = useState(FEEDS_PATH);
  const [defaultBankAccountId, setDefaultBankAccountId] = useState<string | undefined>();
  // The return URL carries one-time codes: finish the link once, even if the effect runs twice.
  const started = useRef(false);

  const leave = (path: string) => router.history.push(path);
  const fail = (message: string) => setState({ phase: 'error', error: { message, detail: null } });

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const run = async () => {
      const pending = readPendingLink();
      // One link per return: whatever happens next, a reload does not replay it.
      clearPendingLink();
      if (!pending) {
        fail(t.callback.errors.noPending);
        return;
      }
      const target = safeReturnPath(pending.returnTo);
      setReturnTo(target);
      setDefaultBankAccountId(pending.defaultBankAccountId);

      const params = new URLSearchParams(window.location.search);
      try {
        let payload: BankFeedCompletePayload;
        if (pending.kind === 'plaid_link') {
          if (!params.get('oauth_state_id') || !pending.linkToken) {
            fail(t.callback.errors.missingOAuthState);
            return;
          }
          const resumed = await resumePlaidOAuth({
            linkToken: pending.linkToken,
            mode: pending.mode,
            receivedRedirectUri: window.location.href,
          });
          if (resumed.status !== 'completed') {
            // The user closed Link: nothing was linked.
            leave(target);
            return;
          }
          payload = resumed.payload;
        } else if (pending.kind === 'redirect') {
          const parsed = redirectPayload(pending, params, t, format);
          if ('error' in parsed) {
            fail(parsed.error);
            return;
          }
          payload = parsed.payload;
        } else {
          fail(t.callback.errors.noPending);
          return;
        }

        const done = await completeLink.mutateAsync({
          provider: pending.provider,
          payload,
          connectionId: pending.mode === 'create' ? undefined : pending.connectionId,
        });
        const { needsMapping } = outcome(done.connection, pending.mode);
        if (needsMapping) setState({ phase: 'mapping', connection: done.connection });
        else leave(target);
      } catch (err) {
        setState({ phase: 'error', error: describeFeedError(err, t, 'link') });
      }
    };

    void run();
    // Runs once per mount; the guard above makes later dependency changes irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 p-6 pt-16 text-center">
      <h1 className="text-lg font-semibold">{t.callback.title}</h1>

      {state.phase === 'error' ? (
        <>
          <Alert variant="destructive" className="text-left">
            <AlertDescription>
              <span>{state.error.message}</span>
              {state.error.detail ? (
                <span className="text-xs">{format(t.errors.detail, { detail: state.error.detail })}</span>
              ) : null}
            </AlertDescription>
          </Alert>
          <Button type="button" onClick={() => leave(returnTo)}>
            {t.callback.backToFeeds}
          </Button>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t.callback.processing}
        </p>
      )}

      {state.phase === 'mapping' ? (
        <AccountMappingDialog
          open
          onOpenChange={(open) => {
            if (!open) leave(returnTo);
          }}
          connection={state.connection}
          defaultBankAccountId={defaultBankAccountId}
        />
      ) : null}
    </div>
  );
}
