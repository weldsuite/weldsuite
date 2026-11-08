import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/legal-entities/detail-page';

export const Route = createFileRoute('/settings/legal-entities/$id/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
