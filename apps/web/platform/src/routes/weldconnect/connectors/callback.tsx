import { createFileRoute, useSearch } from '@tanstack/react-router';
import ConnectorsCallbackPage from '@/app/weldconnect/connectors/callback/page';

export const Route = createFileRoute('/weldconnect/connectors/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    code: (search.code as string) || undefined,
    state: (search.state as string) || undefined,
    error: (search.error as string) || undefined,
  }),
  component: CallbackWrapper,
});

function CallbackWrapper() {
  const { code, state, error } = useSearch({ from: '/weldconnect/connectors/callback' });
  return <ConnectorsCallbackPage code={code} state={state} error={error} />;
}
