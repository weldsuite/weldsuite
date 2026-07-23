import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/accounts/[id]/page';

export const Route = createFileRoute('/weldbooks/accounts/$id/')({
  component: PageComponent,
});
