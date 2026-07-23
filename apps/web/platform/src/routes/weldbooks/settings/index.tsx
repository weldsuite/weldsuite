import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/settings/page';

export const Route = createFileRoute('/weldbooks/settings/')({
  component: PageComponent,
});
