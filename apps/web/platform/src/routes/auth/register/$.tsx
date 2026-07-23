import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/register/[[...sign-up]]/page';

export const Route = createFileRoute('/auth/register/$')({
  component: PageComponent,
});
