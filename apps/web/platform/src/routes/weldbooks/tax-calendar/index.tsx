import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/tax-calendar/page';

export const Route = createFileRoute('/weldbooks/tax-calendar/')({
  component: PageComponent,
});
