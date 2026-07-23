import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/forgot-password/page';

export const Route = createFileRoute('/auth/forgot-password/')({
  component: PageComponent,
});
