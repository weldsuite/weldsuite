import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddocs/page';

export const Route = createFileRoute('/preview/welddocs/')({
  component: PageComponent,
});
