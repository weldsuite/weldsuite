import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/custom-fields/page';

export const Route = createFileRoute('/settings/custom-fields/')({
  component: PageComponent,
});
