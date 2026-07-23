import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/actions/page';

export const Route = createFileRoute('/weldconnect/actions/')({
  component: PageComponent,
});
