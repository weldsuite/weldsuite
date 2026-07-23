import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/(dashboard)/checkout/cancel/page';

export const Route = createFileRoute('/_dashboard/checkout/cancel/')({
  component: PageComponent,
});
