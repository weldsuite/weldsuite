import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/error/page';

export const Route = createFileRoute('/auth/error/')({
  component: PageComponent,
});
