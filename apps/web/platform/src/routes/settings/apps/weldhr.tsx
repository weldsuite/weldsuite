import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldhr/page';

export const Route = createFileRoute('/settings/apps/weldhr')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
