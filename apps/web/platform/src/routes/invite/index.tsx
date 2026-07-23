import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/invite/page';

export const Route = createFileRoute('/invite/')({
  component: PageComponent,
});
