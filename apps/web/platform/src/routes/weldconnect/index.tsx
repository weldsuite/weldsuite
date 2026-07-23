import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/page';

export const Route = createFileRoute('/weldconnect/')({
  component: PageComponent,
});
