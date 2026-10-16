import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldreach/inbox/page';
import '@/lib/breadcrumbs/types';

/**
 * `?thread=<threadKey>` opens a conversation, so a link to a reply survives a
 * reload and can be shared.
 */
export const Route = createFileRoute('/weldreach/inbox/')({
  staticData: { breadcrumb: { labelKey: 'inbox' } },
  validateSearch: (search: Record<string, unknown>): { thread?: string } => ({
    // The router parses search values as JSON, so an all-digit key arrives as a number.
    thread:
      typeof search.thread === 'string' || typeof search.thread === 'number'
        ? String(search.thread)
        : undefined,
  }),
  component: PageComponent,
});
