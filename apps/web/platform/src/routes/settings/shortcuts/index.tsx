import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/shortcuts/page';

export const Route = createFileRoute('/settings/shortcuts/')({
  component: PageComponent,
});
