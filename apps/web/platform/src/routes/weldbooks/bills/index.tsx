import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/bills/page';

export const Route = createFileRoute('/weldbooks/bills/')({
  component: PageComponent,
});
