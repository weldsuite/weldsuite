import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/accounts/tax-lines/page';

export const Route = createFileRoute('/weldbooks/accounts/tax-lines/')({
  component: PageComponent,
});
