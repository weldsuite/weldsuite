import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/legal-entities/page';

export const Route = createFileRoute('/settings/legal-entities/')({
  component: PageComponent,
});
