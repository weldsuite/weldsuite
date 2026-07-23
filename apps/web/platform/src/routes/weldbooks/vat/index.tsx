import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/vat/page';

export const Route = createFileRoute('/weldbooks/vat/')({
  component: PageComponent,
});
