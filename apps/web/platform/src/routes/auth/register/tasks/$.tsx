import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/register/tasks/[[...tasks]]/page';

export const Route = createFileRoute('/auth/register/tasks/$')({
  component: PageComponent,
});
