import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/to-process/page';

export const Route = createFileRoute('/weldbooks/to-process/')({
  component: PageComponent,
});
