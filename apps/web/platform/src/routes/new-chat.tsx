import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/new-chat-page';

export const Route = createFileRoute('/new-chat')({
  validateSearch: (search: Record<string, unknown>) => ({
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
    conversation: typeof search.conversation === 'string' ? search.conversation : undefined,
  }),
  component: PageComponent,
});
