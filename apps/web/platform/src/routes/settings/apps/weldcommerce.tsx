import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldcommerce/page';

export const Route = createFileRoute('/settings/apps/weldcommerce')({
  // `mollie` and `reason` are the result of the Mollie Connect callback (Payments tab); the page shows it and removes it.
  validateSearch: (search: Record<string, unknown>): { tab?: string; channel?: string; mollie?: string; reason?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    channel: typeof search.channel === 'string' ? search.channel : undefined,
    mollie: typeof search.mollie === 'string' ? search.mollie : undefined,
    reason: typeof search.reason === 'string' ? search.reason : undefined,
  }),
  component: PageComponent,
});
