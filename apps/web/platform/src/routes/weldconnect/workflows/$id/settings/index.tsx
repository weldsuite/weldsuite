import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/workflows/[id]/settings/page';

export const Route = createFileRoute('/weldconnect/workflows/$id/settings/')({
  component: PageComponent,
});
