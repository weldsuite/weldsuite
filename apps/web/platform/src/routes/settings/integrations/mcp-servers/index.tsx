import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/mcp-servers/page';

export const Route = createFileRoute('/settings/integrations/mcp-servers/')({
  component: PageComponent,
});
