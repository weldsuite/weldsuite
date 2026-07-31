import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/custom-objects/detail-page';

export const Route = createFileRoute('/settings/custom-objects/$objectId')({
  component: PageComponent,
});
