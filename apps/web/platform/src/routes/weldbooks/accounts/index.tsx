import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/accounts/page';

export const Route = createFileRoute('/weldbooks/accounts/')({
  component: PageComponent,
});
