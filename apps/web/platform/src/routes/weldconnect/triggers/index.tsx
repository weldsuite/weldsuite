import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/triggers/page';

export const Route = createFileRoute('/weldconnect/triggers/')({
  component: PageComponent,
});
