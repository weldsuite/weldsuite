import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/me/announcements/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me/announcements/')({
  staticData: { breadcrumb: { labelKey: 'announcements' } },
  // Push notifications open `?announcement=<id>`: that announcement is shown open.
  validateSearch: (search: Record<string, unknown>): { announcement?: string } => ({
    announcement: typeof search.announcement === 'string' ? search.announcement : undefined,
  }),
  component: PageComponent,
});
