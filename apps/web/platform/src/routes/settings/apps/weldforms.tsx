import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldforms/page';

export const Route = createFileRoute('/settings/apps/weldforms')({
  component: PageComponent,
});
