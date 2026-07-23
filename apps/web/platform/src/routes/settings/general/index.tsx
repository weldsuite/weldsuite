import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/general/page';

export const Route = createFileRoute('/settings/general/')({
  component: PageComponent,
});
