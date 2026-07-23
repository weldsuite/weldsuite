import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/integrations/page';

export const Route = createFileRoute('/weldconnect/integrations/')({
  component: PageComponent,
});
