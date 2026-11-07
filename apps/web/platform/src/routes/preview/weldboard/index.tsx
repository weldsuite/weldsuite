import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldboard/page';

export const Route = createFileRoute('/preview/weldboard/')({
  component: PageComponent,
});
