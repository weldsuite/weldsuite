import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/quotes/[id]/edit/page';

export const Route = createFileRoute('/weldbooks/quotes/$id/edit/')({
  component: PageComponent,
});
