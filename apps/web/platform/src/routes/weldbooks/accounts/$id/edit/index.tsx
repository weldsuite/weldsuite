import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/accounts/[id]/edit/page';

export const Route = createFileRoute('/weldbooks/accounts/$id/edit/')({
  component: PageComponent,
});
