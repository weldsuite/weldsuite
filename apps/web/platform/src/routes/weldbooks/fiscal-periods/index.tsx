import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/fiscal-periods/page';

export const Route = createFileRoute('/weldbooks/fiscal-periods/')({
  component: PageComponent,
});
