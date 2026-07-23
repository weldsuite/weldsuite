import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/advanced/page';

export const Route = createFileRoute('/settings/advanced/')({
  component: PageComponent,
});
