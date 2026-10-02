import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmeet/new/page';

export const Route = createFileRoute('/weldmeet/new/')({
  // `from`: id of a meeting to schedule again (pre-fills the schedule card).
  validateSearch: (search: Record<string, unknown>): { from?: string } => ({
    from: typeof search.from === 'string' && search.from ? search.from : undefined,
  }),
  component: PageComponent,
});
