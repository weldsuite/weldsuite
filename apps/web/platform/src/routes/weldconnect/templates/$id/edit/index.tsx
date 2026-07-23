import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/templates/[id]/edit/page';

export const Route = createFileRoute('/weldconnect/templates/$id/edit/')({
  component: PageComponent,
});
