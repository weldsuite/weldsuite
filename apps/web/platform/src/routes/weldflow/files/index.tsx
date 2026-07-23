import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/files/page';

export const Route = createFileRoute('/weldflow/files/')({
  component: PageComponent,
});
