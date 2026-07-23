import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/documents/page';

export const Route = createFileRoute('/weldflow/documents/')({
  component: PageComponent,
});
