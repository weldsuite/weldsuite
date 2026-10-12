import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldreach/campaigns/[campaignId]/page';

/**
 * `?tab=<sequence|prospects|mailboxes|settings|stats>` selects the tab, so a
 * link to a specific section survives a reload and can be shared.
 */
export const Route = createFileRoute('/weldreach/campaigns/$campaignId/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
