import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welcome/page';

export const Route = createFileRoute('/welcome/')({
  component: PageComponent,
});
