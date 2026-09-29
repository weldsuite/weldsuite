import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/page';

export const Route = createFileRoute('/weldcommerce/')({
  component: PageComponent,
});
