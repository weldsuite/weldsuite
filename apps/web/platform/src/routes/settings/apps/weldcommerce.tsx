import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldcommerce/page';

export const Route = createFileRoute('/settings/apps/weldcommerce')({
  // `mollie` and `reason` are the result of the Mollie Connect callback (Payments tab); the page shows it and removes it.
  // `site` is the online store the Online store tab shows.
  validateSearch: (search: Record<string, unknown>): { tab?: string; channel?: string; mollie?: string; reason?: string; site?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    channel: typeof search.channel === 'string' ? search.channel : undefined,
    mollie: typeof search.mollie === 'string' ? search.mollie : undefined,
    reason: typeof search.reason === 'string' ? search.reason : undefined,
    site: typeof search.site === 'string' ? search.site : undefined,
  }),
  component: PageComponent,
});
