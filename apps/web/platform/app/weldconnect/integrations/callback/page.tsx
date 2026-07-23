import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { useWorkflowProviderCallback } from '@/hooks/queries/use-workflow-integration-queries';

interface CallbackPageProps {
  code: string | undefined;
  state: string | undefined;
}

type CallbackStatus = 'loading' | 'success' | 'error';

export default function IntegrationsCallbackPage({ code, state }: CallbackPageProps) {
  const { t } = useI18n();
  const ti = t.weldconnect.integrations;
  const navigate = useNavigate();
  const callbackMutation = useWorkflowProviderCallback();
  const calledRef = useRef(false);
  const [status, setStatus] = useState<CallbackStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    // Guard: run once
    if (calledRef.current) return;
    calledRef.current = true;

    const provider = sessionStorage.getItem('wf_oauth_provider');

    if (!code || !state) {
      setStatus('error');
      setErrorMessage(ti.callback.errorMissingParams);
      return;
    }

    if (!provider) {
      setStatus('error');
      setErrorMessage(ti.callback.errorMissingProvider);
      return;
    }

    callbackMutation.mutate(
      { provider, code, state },
      {
        onSuccess: () => {
          sessionStorage.removeItem('wf_oauth_provider');
          setStatus('success');
          setTimeout(() => {
            navigate({ to: '/weldconnect/integrations' });
          }, 1500);
        },
        onError: (err: unknown) => {
          const msg =
            err instanceof Error ? err.message : ti.callback.errorGeneric;
          setStatus('error');
          setErrorMessage(msg);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        {status === 'loading' && (
          <>
            <Loader2 className="h-12 w-12 animate-spin text-muted-foreground mx-auto mb-4" />
            <h1 className="text-lg font-semibold">{ti.callback.connecting}</h1>
            <p className="text-sm text-muted-foreground mt-2">{ti.callback.connectingHint}</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <h1 className="text-lg font-semibold">{ti.callback.success}</h1>
            <p className="text-sm text-muted-foreground mt-2">{ti.callback.successHint}</p>
          </>
        )}

        {status === 'error' && (
          <>
            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h1 className="text-lg font-semibold">{ti.callback.error}</h1>
            <p className="text-sm text-muted-foreground mt-2">
              {errorMessage || ti.callback.errorGeneric}
            </p>
            <Button
              className="mt-6"
              onClick={() => navigate({ to: '/weldconnect/integrations' })}
            >
              {ti.callback.backToIntegrations}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
