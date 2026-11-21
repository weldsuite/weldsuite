import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldcommerce/page';

export const Route = createFileRoute('/settings/apps/weldcommerce')({
  validateSearch: (search: Record<string, unknown>): { tab?: string; channel?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    channel: typeof search.channel === 'string' ? search.channel : undefined,
  }),
  component: PageComponent,
});
