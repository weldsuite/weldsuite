import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/import/page';

export const Route = createFileRoute('/weldbooks/banking/import/')({
  component: PageComponent,
});
