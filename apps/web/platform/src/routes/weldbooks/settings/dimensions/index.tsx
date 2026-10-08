import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/settings/dimensions/page';

export const Route = createFileRoute('/weldbooks/settings/dimensions/')({
  component: PageComponent,
});
