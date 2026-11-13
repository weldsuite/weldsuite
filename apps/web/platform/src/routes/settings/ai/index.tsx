import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/ai/page';

export const Route = createFileRoute('/settings/ai/')({
  component: PageComponent,
});
