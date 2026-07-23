import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldmail/page';

export const Route = createFileRoute('/settings/apps/weldmail/')({
  component: PageComponent,
});
