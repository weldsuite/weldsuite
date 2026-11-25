import { createFileRoute, useSearch } from '@tanstack/react-router';
import IntegrationsCallbackPage from '@/app/settings/integrations/callback/page';

// The return URL Google and Slack were registered with for workflow
// connections before they moved to Settings → Integrations; Global's backend
// still sends it. `weldconnect_` keeps it out of WeldConnect's layout, so it
// works without WeldConnect installed. Remove it once Global is retired.
export const Route = createFileRoute('/weldconnect_/integrations/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    code: (search.code as string) || undefined,
    state: (search.state as string) || undefined,
    error: (search.error as string) || undefined,
  }),
  component: CallbackWrapper,
});

function CallbackWrapper() {
  const { code, state, error } = useSearch({ from: '/weldconnect_/integrations/callback' });
  return <IntegrationsCallbackPage code={code} state={state} error={error} flow="workflow" />;
}
