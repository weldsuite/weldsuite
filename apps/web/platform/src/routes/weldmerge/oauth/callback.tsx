import { createFileRoute, useSearch } from '@tanstack/react-router';
import WeldMergeOauthCallbackPage from '@/app/weldmerge/oauth/callback-page';

export const Route = createFileRoute('/weldmerge/oauth/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    code: (search.code as string) || undefined,
    state: (search.state as string) || undefined,
    error: (search.error as string) || undefined,
    error_description: (search.error_description as string) || undefined,
  }),
  component: CallbackWrapper,
});

function CallbackWrapper() {
  const { code, state, error, error_description: errorDescription } = useSearch({ from: '/weldmerge/oauth/callback' });
  return <WeldMergeOauthCallbackPage code={code} state={state} error={error} errorDescription={errorDescription} />;
}
