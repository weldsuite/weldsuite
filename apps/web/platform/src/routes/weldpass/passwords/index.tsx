import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpass/passwords/page';
import '@/lib/breadcrumbs/types';

/**
 * `?vault=<vaultId>` filters to one vault and `?item=<itemId>` opens an item,
 * so both survive a reload and can be linked to (the health report does).
 */
export const Route = createFileRoute('/weldpass/passwords/')({
  staticData: { breadcrumb: { label: 'Passwords' } },
  validateSearch: (search: Record<string, unknown>): { vault?: string; item?: string } => ({
    vault: typeof search.vault === 'string' && search.vault ? search.vault : undefined,
    item: typeof search.item === 'string' && search.item ? search.item : undefined,
  }),
  component: PageComponent,
});
