import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/people/page';

export const Route = createFileRoute('/weldcrm/people/')({
  component: PageComponent,
});
