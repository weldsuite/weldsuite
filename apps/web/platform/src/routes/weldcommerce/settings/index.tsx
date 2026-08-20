import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/settings/page';

export const Route = createFileRoute('/weldcommerce/settings/')({
  component: PageComponent,
});
