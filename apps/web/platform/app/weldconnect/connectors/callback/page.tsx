import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import {
  useConnectorOAuthCallback,
  useSelectConnectorAccount,
  type MoneybirdAdministration,
} from '@/hooks/queries/use-connector-queries';

interface CallbackPageProps {
  code: string | undefined;
  state: string | undefined;
  error: string | undefined;
}

type Status = 'loading' | 'picker' | 'success' | 'error';

function safeReturnPath(returnUrl: string | undefined): string {
  if (!returnUrl) return '/weldconnect/connectors';
  try {
    const parsed = new URL(returnUrl);
    if (parsed.pathname.startsWith('/weldconnect/connectors') || parsed.pathname.startsWith('/settings/integrations/')) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    /* fall through */
  }
  return '/weldconnect/connectors';
}

export default function ConnectorsCallbackPage({ code, state, error }: CallbackPageProps) {
  const { t } = useI18n();
  const tc = t.weldconnect.connectors;
  const callback = useConnectorOAuthCallback();
  const selectAccount = useSelectConnectorAccount();
  const calledRef = useRef(false);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [administrations, setAdministrations] = useState<MoneybirdAdministration[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [returnPath, setReturnPath] = useState('/weldconnect/connectors');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    if (error) {
      setStatus('error');
      setErrorMessage(tc.authDenied);
      return;
    }
    if (!code || !state) {
      setStatus('error');
      setErrorMessage(tc.callbackMissingParams);
      return;
    }

    callback.mutate(
      { provider: 'moneybird', code, state },
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
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="text-center max-w-sm w-full">
        {status === 'loading' && (
          <>
            <Loader2 className="h-12 w-12 animate-spin text-muted-foreground mx-auto mb-4" />
            <h1 className="text-lg font-semibold">{tc.callbackConnecting}</h1>
            <p className="text-sm text-muted-foreground mt-2">{tc.callbackConnectingHint}</p>
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
