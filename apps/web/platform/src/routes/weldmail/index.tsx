import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/page';

export const Route = createFileRoute('/weldmail/')({
  component: PageComponent,
});
