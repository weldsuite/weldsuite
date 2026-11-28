import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/quotes/add/page';

export const Route = createFileRoute('/weldbooks/quotes/add/')({
  component: PageComponent,
});
