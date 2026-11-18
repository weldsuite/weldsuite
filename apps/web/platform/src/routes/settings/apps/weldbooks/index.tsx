import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldbooks/page';

export const Route = createFileRoute('/settings/apps/weldbooks/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
