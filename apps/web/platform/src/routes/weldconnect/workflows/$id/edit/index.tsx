import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/workflows/[id]/edit/page';

export const Route = createFileRoute('/weldconnect/workflows/$id/edit/')({
  component: PageComponent,
});
