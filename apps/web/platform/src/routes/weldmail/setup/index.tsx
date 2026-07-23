import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/setup/page';

export const Route = createFileRoute('/weldmail/setup/')({
  component: PageComponent,
});
