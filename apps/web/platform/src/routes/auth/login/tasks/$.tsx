import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/login/tasks/[[...tasks]]/page';

export const Route = createFileRoute('/auth/login/tasks/$')({
  component: PageComponent,
});
