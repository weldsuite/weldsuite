import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/custom-objects/page';

export const Route = createFileRoute('/settings/custom-objects/')({
  component: PageComponent,
});
