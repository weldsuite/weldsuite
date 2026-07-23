import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/webhooks/page';

export const Route = createFileRoute('/settings/webhooks/')({
  component: PageComponent,
});
