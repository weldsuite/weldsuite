import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/desktop-handoff/page';

export const Route = createFileRoute('/auth/desktop-handoff/')({
  component: PageComponent,
});
