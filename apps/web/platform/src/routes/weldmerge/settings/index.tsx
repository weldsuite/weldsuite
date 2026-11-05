import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmerge/settings/page';
import '@/lib/breadcrumbs/types';

/**
 * `?installed=1` is where the GitHub App installation returns to; the page then retries the connection.
 * `?tab=` opens a section (the OAuth callback returns to `providers` or `accounts`).
 */
export const Route = createFileRoute('/weldmerge/settings/')({
  staticData: { breadcrumb: { labelKey: 'settings' } },
  validateSearch: (search: Record<string, unknown>): { installed?: string; tab?: string } => ({
    installed: typeof search.installed === 'string' || typeof search.installed === 'number' ? String(search.installed) : undefined,
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  component: PageComponent,
});
