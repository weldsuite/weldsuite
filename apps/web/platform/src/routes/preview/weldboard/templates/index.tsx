import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldboard/templates/page';

export const Route = createFileRoute('/preview/weldboard/templates/')({
  component: PageComponent,
});
