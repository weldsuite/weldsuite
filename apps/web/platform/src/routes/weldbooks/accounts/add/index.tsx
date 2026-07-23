import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/accounts/add/page';

export const Route = createFileRoute('/weldbooks/accounts/add/')({
  component: PageComponent,
});
