import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/outside-eu/page';

export const Route = createFileRoute('/settings/outside-eu/')({
  component: PageComponent,
});
