import { createFileRoute, useSearch } from '@tanstack/react-router';
import IntegrationsCallbackPage from '@/app/settings/integrations/callback/page';

// Where OAuth providers send the browser back on the EU and self-hosted
// editions: Moneybird and Stripe (connectors) and Google and Slack (workflow
// connections). Global still sends the old `/weldconnect/...` URLs
// (src/routes/weldconnect_/).
export const Route = createFileRoute('/settings/integrations/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    code: (search.code as string) || undefined,
    state: (search.state as string) || undefined,
    error: (search.error as string) || undefined,
  }),
  component: CallbackWrapper,
});

function CallbackWrapper() {
  const { code, state, error } = useSearch({ from: '/settings/integrations/callback' });
  return <IntegrationsCallbackPage code={code} state={state} error={error} />;
}
