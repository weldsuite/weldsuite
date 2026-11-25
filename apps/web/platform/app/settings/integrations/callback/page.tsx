import { useMemo } from 'react';
import { readOAuthFlow, type OAuthFlow } from '@/lib/integrations-oauth-flow';
import { ConnectorCallback } from './connector-callback';
import { WorkflowCallback } from './workflow-callback';

export interface IntegrationsCallbackProps {
  code: string | undefined;
  state: string | undefined;
  error: string | undefined;
  /**
   * Which flow this URL always finishes. The old WeldConnect return URLs
   * (`/weldconnect/connectors/callback`, `/weldconnect/integrations/callback`)
   * each serve one; `/settings/integrations/callback` reads the flow the
   * browser recorded before it left.
   */
  flow?: OAuthFlow['kind'];
}

/**
 * Where every OAuth flow of Settings → Integrations comes back: store and
 * accounting connectors (Moneybird, Stripe) and the connections workflow
 * steps use (Google, Slack).
 */
export default function IntegrationsCallbackPage({ code, state, error, flow }: Readonly<IntegrationsCallbackProps>) {
  const recorded = useMemo(() => readOAuthFlow(), []);
  const kind = flow ?? recorded?.kind ?? 'connector';

  if (kind === 'workflow') {
    return (
      <WorkflowCallback
        code={code}
        state={state}
        provider={recorded?.kind === 'workflow' ? recorded.provider : null}
        returnTo={recorded?.returnTo}
      />
    );
  }
  return <ConnectorCallback code={code} state={state} error={error} />;
}
