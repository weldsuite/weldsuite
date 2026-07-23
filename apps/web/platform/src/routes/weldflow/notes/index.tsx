import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/notes/page';

export const Route = createFileRoute('/weldflow/notes/')({
  component: PageComponent,
});
