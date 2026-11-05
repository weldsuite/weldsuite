import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmerge/settings/page';
import '@/lib/breadcrumbs/types';

/** `?installed=1` is where the GitHub App installation returns to; the page then retries the connection. */
export const Route = createFileRoute('/weldmerge/settings/')({
  staticData: { breadcrumb: { labelKey: 'settings' } },
  validateSearch: (search: Record<string, unknown>): { installed?: string } => ({
    installed: typeof search.installed === 'string' || typeof search.installed === 'number' ? String(search.installed) : undefined,
  }),
  component: PageComponent,
});
