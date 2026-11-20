import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldstash/page';

export const Route = createFileRoute('/settings/apps/weldstash')({
  component: PageComponent,
});
