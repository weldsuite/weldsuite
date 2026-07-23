import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/rules/page';

export const Route = createFileRoute('/weldbooks/banking/rules/')({
  component: PageComponent,
});
