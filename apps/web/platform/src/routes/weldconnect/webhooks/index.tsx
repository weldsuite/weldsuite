import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/webhooks/page';

export const Route = createFileRoute('/weldconnect/webhooks/')({
  component: PageComponent,
});
