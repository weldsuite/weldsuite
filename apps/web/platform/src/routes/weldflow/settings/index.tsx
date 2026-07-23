import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/settings/page';

export const Route = createFileRoute('/weldflow/settings/')({
  component: PageComponent,
});
