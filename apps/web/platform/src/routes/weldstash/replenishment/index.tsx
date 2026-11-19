import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/replenishment/page';

/**
 * `?tab=` selects the tab (reorder, items, settings) and `?plan=` opens an
 * item's panel, so a link to either survives a reload and can be shared.
 */
export const Route = createFileRoute('/weldstash/replenishment/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string; plan?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    plan: typeof search.plan === 'string' ? search.plan : undefined,
  }),
  component: PageComponent,
});
