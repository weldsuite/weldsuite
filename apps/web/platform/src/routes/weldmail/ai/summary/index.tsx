import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/ai/summary/page';

export const Route = createFileRoute('/weldmail/ai/summary/')({
  component: PageComponent,
});
