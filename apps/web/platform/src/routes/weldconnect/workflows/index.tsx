import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/workflows/page';

export const Route = createFileRoute('/weldconnect/workflows/')({
  component: PageComponent,
});
