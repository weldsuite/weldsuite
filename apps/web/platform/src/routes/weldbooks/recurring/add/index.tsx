import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/recurring/add/page';

export const Route = createFileRoute('/weldbooks/recurring/add/')({
  component: PageComponent,
});
