import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldcommerce/page';

export const Route = createFileRoute('/settings/apps/weldcommerce')({
  component: PageComponent,
});
