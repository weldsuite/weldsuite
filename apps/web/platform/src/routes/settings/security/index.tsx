import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/security/page';

export const Route = createFileRoute('/settings/security/')({
  component: PageComponent,
});
