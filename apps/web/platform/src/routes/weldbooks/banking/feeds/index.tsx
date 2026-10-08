import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/feeds/page';

export const Route = createFileRoute('/weldbooks/banking/feeds/')({
  component: PageComponent,
});
