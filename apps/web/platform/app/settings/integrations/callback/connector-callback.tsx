import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { parseWorkspacePath } from '@/lib/workspace-url';
import {
  useConnectorOAuthCallback,
  useSelectConnectorAccount,
  type MoneybirdAdministration,
} from '@/hooks/queries/use-connector-queries';
import { clearOAuthFlow } from '@/lib/integrations-oauth-flow';

interface ConnectorCallbackProps {
  code: string | undefined;
  state: string | undefined;
  error: string | undefined;
}

type Status = 'loading' | 'picker' | 'success' | 'error';

const INTEGRATIONS_PATH = '/settings/integrations';

/**
 * Where to land afterwards: the Settings → Integrations page the flow started
 * from (the connection's `returnUrl`), or the integrations list. A return to
 * the old WeldConnect connectors page lands on the list.
 */
export function safeReturnPath(returnUrl: string | undefined): string {
  if (!returnUrl) return INTEGRATIONS_PATH;
  try {
    const parsed = new URL(returnUrl, window.location.origin);
    if (parsed.origin !== window.location.origin) return INTEGRATIONS_PATH;
    // A `/w/{workspace}/…` return keeps its prefix, so the tab lands back in that workspace.
    const page = parseWorkspacePath(parsed.pathname)?.rest ?? parsed.pathname;
    if (page === INTEGRATIONS_PATH || page.startsWith(`${INTEGRATIONS_PATH}/`)) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    /* fall through */
  }
  return INTEGRATIONS_PATH;
}

function providerFromState(state: string): 'stripe' | 'moneybird' {
  return state.startsWith('stripe_') ? 'stripe' : 'moneybird';
}

/** Finishes a Moneybird or Stripe connect, with Moneybird's administration picker. */
export function ConnectorCallback({ code, state, error }: Readonly<ConnectorCallbackProps>) {
  const { t } = useI18n();
  const tc = t.settings.integrations.connectors;
  const callback = useConnectorOAuthCallback();
  const selectAccount = useSelectConnectorAccount();
  const calledRef = useRef(false);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [administrations, setAdministrations] = useState<MoneybirdAdministration[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [returnPath, setReturnPath] = useState(INTEGRATIONS_PATH);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [provider, setProvider] = useState<'stripe' | 'moneybird'>('moneybird');

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;
    clearOAuthFlow();

    if (error) {
      setStatus('error');
      setErrorMessage(tc.authDenied);
      return;
    }
    if (!code || !state) {
      setStatus('error');
      setErrorMessage(tc.callbackMissingParamsGeneric);
      return;
    }

    const resolvedProvider = providerFromState(state);
    setProvider(resolvedProvider);

    callback.mutate(
      { provider: resolvedProvider, code, state },
      {
        onSuccess: (result) => {
          const data = result.data;
          setReturnPath(safeReturnPath(data.returnUrl));
          if (data.needsPicker) {
            setConnectionId(data.connection.id);
            setAdministrations(data.administrations);
            setSelectedId(data.administrations[0]?.id ?? null);
            setStatus('picker');
            return;
          }
          setStatus('success');
          setTimeout(() => {
            window.location.assign(safeReturnPath(data.returnUrl));
          }, 1200);
        },
        onError: (err: unknown) => {
          setStatus('error');
          setErrorMessage(err instanceof Error ? err.message : tc.connectFailed);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelect = () => {
    if (!connectionId || !selectedId) return;
    selectAccount.mutate(
      { connectionId, administrationId: selectedId },
      {
        onSuccess: () => {
          setStatus('success');
          setTimeout(() => {
            window.location.assign(returnPath);
          }, 1200);
        },
        onError: (err: unknown) => {
          setStatus('error');
          setErrorMessage(err instanceof Error ? err.message : tc.connectFailed);
        },
      },
    );
  };

  return (
    <div className="flex min-h-[calc(100vh-8rem)] w-full items-center justify-center px-4 pb-[60px]">
      <div className="text-center max-w-sm w-full">
        {status === 'loading' && (
          <>
            <Loader2 className="h-12 w-12 animate-spin text-muted-foreground mx-auto mb-4" />
            <h1 className="text-lg font-semibold">
              {provider === 'stripe' ? tc.callbackConnectingStripe : tc.callbackConnecting}
            </h1>
            <p className="text-sm text-muted-foreground mt-2">
              {provider === 'stripe' ? tc.callbackConnectingHintStripe : tc.callbackConnectingHint}
            </p>
          </>
        )}

        {status === 'picker' && (
          <>
            <h1 className="text-lg font-semibold">{tc.pickAdministration}</h1>
            <p className="text-sm text-muted-foreground mt-2 mb-4">{tc.pickAdministrationHint}</p>
            <div className="space-y-2 text-left">
              {administrations.map((admin) => (
                <button
                  key={admin.id}
                  type="button"
                  onClick={() => setSelectedId(admin.id)}
                  className={`w-full rounded-md border px-3 py-2 text-sm ${
                    selectedId === admin.id ? 'border-primary bg-muted' : 'border-border'
                  }`}
                >
                  <span className="font-medium">{admin.name}</span>
                  {admin.currency ? (
                    <span className="text-muted-foreground ml-2 text-xs">{admin.currency}</span>
                  ) : null}
                </button>
              ))}
            </div>
            <Button className="mt-6 w-full" onClick={handleSelect} disabled={!selectedId || selectAccount.isPending}>
              {selectAccount.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {tc.connect}
            </Button>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <h1 className="text-lg font-semibold">{tc.connected}</h1>
            <p className="text-sm text-muted-foreground mt-2">{tc.authReturned}</p>
          </>
        )}

        {status === 'error' && (
          <>
            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h1 className="text-lg font-semibold">{tc.connectFailed}</h1>
            <p className="text-sm text-muted-foreground mt-2">{errorMessage || tc.connectFailed}</p>
            <Button className="mt-6" onClick={() => window.location.assign(returnPath)}>
              {tc.title}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
