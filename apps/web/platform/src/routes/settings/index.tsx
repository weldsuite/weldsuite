import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/page';

export const Route = createFileRoute('/settings/')({
  component: PageComponent,
});
