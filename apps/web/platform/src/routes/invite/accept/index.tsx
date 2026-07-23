import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/invite/accept/page';

export const Route = createFileRoute('/invite/accept/')({
  component: PageComponent,
});
