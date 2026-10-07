import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpass/passwords/vaults/[vaultId]/page';

/** `?item=<itemId>` opens an item, so it survives a reload and can be linked to. */
export const Route = createFileRoute('/weldpass/passwords/vaults/$vaultId/')({
  validateSearch: (search: Record<string, unknown>): { item?: string } => ({
    item: typeof search.item === 'string' && search.item ? search.item : undefined,
  }),
  component: PageComponent,
});
