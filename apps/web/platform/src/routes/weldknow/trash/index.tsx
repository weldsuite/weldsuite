import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldknow/trash/page';

export const Route = createFileRoute('/weldknow/trash/')({
  component: PageComponent,
});
