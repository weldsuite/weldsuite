import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmerge/page';

export const Route = createFileRoute('/weldmerge/')({
  component: PageComponent,
});
