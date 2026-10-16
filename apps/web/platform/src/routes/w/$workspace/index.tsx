import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/workspace-link/page';

export const Route = createFileRoute('/w/$workspace/')({
  component: PageComponent,
});
