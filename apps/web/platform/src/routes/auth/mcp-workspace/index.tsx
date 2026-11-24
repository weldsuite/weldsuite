import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/mcp-workspace/page';

export const Route = createFileRoute('/auth/mcp-workspace/')({
  component: PageComponent,
});
