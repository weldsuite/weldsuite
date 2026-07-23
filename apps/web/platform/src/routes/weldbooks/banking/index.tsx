import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/page';

export const Route = createFileRoute('/weldbooks/banking/')({
  component: PageComponent,
});
