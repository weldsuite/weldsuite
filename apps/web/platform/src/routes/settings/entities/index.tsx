import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/entities/page';

export const Route = createFileRoute('/settings/entities/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
