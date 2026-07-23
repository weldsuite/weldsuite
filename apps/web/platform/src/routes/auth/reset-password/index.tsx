import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/reset-password/page';

export const Route = createFileRoute('/auth/reset-password/')({
  component: PageComponent,
});
