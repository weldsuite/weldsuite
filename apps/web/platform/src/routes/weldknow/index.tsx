import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldknow/page';

export const Route = createFileRoute('/weldknow/')({
  component: PageComponent,
});
