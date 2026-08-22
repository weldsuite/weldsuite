import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldads/connect/callback/page';

export const Route = createFileRoute('/weldads/connect/callback/')({
  staticData: { breadcrumb: { label: 'Connect' } },
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === 'string' ? search.code : undefined,
    state: typeof search.state === 'string' ? search.state : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: () => {
    const { code, state, error } = Route.useSearch();
    return <PageComponent code={code} state={state} error={error} />;
  },
});
