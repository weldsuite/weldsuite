import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/statements/page';

export const Route = createFileRoute('/weldbooks/banking/statements/')({
  component: PageComponent,
});
