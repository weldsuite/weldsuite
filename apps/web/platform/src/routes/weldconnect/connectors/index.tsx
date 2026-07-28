import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/connectors/page';

export const Route = createFileRoute('/weldconnect/connectors/')({
  component: PageComponent,
});
