import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhost/page';

export const Route = createFileRoute('/weldhost/')({
  component: PageComponent,
});
