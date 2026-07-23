import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/journal/add/page';

export const Route = createFileRoute('/weldbooks/journal/add/')({
  component: PageComponent,
});
