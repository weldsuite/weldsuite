import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/templates/page';

export const Route = createFileRoute('/weldconnect/templates/')({
  component: PageComponent,
});
