import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/settings/labels/page';

export const Route = createFileRoute('/weldmail/settings/labels/')({
  component: PageComponent,
});
