import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/ai/smart-reply/page';

export const Route = createFileRoute('/weldmail/ai/smart-reply/')({
  component: PageComponent,
});
