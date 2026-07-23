import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/webhooks/[id]/page';

export const Route = createFileRoute('/weldconnect/webhooks/$id/')({
  component: PageComponent,
});
