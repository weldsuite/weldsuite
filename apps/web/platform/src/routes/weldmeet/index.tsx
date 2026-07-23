import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmeet/new/page';

export const Route = createFileRoute('/weldmeet/')({
  component: PageComponent,
});
