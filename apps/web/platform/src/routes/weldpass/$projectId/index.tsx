import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpass/[projectId]/page';

/**
 * `?env=<environmentId>` selects the environment tab, so a link to a specific
 * environment survives a reload and can be shared.
 */
export const Route = createFileRoute('/weldpass/$projectId/')({
  validateSearch: (search: Record<string, unknown>): { env?: string } => ({
    env: typeof search.env === 'string' ? search.env : undefined,
  }),
  component: PageComponent,
});
