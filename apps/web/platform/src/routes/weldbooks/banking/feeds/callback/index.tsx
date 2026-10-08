import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/feeds/callback-page';

export const Route = createFileRoute('/weldbooks/banking/feeds/callback/')({
  component: PageComponent,
});
