import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { useWorkflowProviderCallback } from '@/hooks/queries/use-workflow-integration-queries';
import { clearOAuthFlow } from '@/lib/integrations-oauth-flow';
import { parseWorkspacePath } from '@/lib/workspace-url';
import { workflowProviderSettingsPath } from '../workflow/providers';

interface WorkflowCallbackProps {
  code: string | undefined;
  state: string | undefined;
  /** The provider the flow was started for; null when the browser forgot it. */
  provider: string | null;
  /** The page the flow was started from. */
  returnTo: string | undefined;
}

type CallbackStatus = 'loading' | 'success' | 'error';

/** Back to the Settings page the flow started from, or the provider's page. */
function landingPath(provider: string | null, returnTo: string | undefined): string {
  if (returnTo) {
    const page = parseWorkspacePath(returnTo)?.rest ?? returnTo;
    if (page.startsWith('/settings/integrations')) return returnTo;
  }
  return provider ? workflowProviderSettingsPath(provider) : '/settings/integrations';
}

/** Finishes the OAuth connect of a provider workflow steps use (Google, Slack). */
export function WorkflowCallback({ code, state, provider, returnTo }: Readonly<WorkflowCallbackProps>) {
  const { t } = useI18n();
  const ti = t.settings.integrations.workflowConnections;
  const callbackMutation = useWorkflowProviderCallback();
  const calledRef = useRef(false);
  const [status, setStatus] = useState<CallbackStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const landing = landingPath(provider, returnTo);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

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
          clearOAuthFlow();
          setStatus('success');
          setTimeout(() => window.location.assign(landing), 1500);
        },
        onError: (err: unknown) => {
          setStatus('error');
          setErrorMessage(err instanceof Error ? err.message : ti.callback.errorGeneric);
        },
      },
    );
    // Runs once: the mutation and copy are stable enough for a single callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-[calc(100vh-8rem)] w-full items-center justify-center px-4 pb-[60px]">
      <div className="max-w-sm text-center" role="status">
        {status === 'loading' && (
          <>
            <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-muted-foreground" aria-hidden="true" />
            <h1 className="text-lg font-semibold">{ti.callback.connecting}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{ti.callback.connectingHint}</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-green-500" aria-hidden="true" />
            <h1 className="text-lg font-semibold">{ti.callback.success}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{ti.callback.successHint}</p>
          </>
        )}

        {status === 'error' && (
          <>
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" aria-hidden="true" />
            <h1 className="text-lg font-semibold">{ti.callback.error}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{errorMessage || ti.callback.errorGeneric}</p>
            <Button className="mt-6" onClick={() => window.location.assign(landing)}>
              {ti.callback.backToIntegrations}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
