import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/page';

export const Route = createFileRoute('/preview/weldflow/')({
  component: PageComponent,
});
