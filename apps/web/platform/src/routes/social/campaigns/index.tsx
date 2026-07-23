import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/campaigns/page';

export const Route = createFileRoute('/social/campaigns/')({
  component: PageComponent,
});
