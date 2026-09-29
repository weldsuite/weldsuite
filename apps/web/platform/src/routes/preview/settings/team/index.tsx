import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/team/page';

export const Route = createFileRoute('/preview/settings/team/')({
  component: PageComponent,
});
