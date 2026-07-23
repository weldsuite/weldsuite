import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/settings/page';

export const Route = createFileRoute('/social/settings/')({
  component: PageComponent,
});
