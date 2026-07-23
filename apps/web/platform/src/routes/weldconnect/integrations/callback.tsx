import { createFileRoute, useSearch } from '@tanstack/react-router';
import IntegrationsCallbackPage from '@/app/weldconnect/integrations/callback/page';

export const Route = createFileRoute('/weldconnect/integrations/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    code: (search.code as string) || undefined,
    state: (search.state as string) || undefined,
  }),
  component: CallbackWrapper,
});

function CallbackWrapper() {
  const { code, state } = useSearch({ from: '/weldconnect/integrations/callback' });
  return <IntegrationsCallbackPage code={code} state={state} />;
}
