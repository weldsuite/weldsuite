import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/recurring/page';

export const Route = createFileRoute('/weldbooks/recurring/')({
  component: PageComponent,
});
