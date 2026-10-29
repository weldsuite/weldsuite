import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/page';

export const Route = createFileRoute('/weldpanel/')({
  component: PageComponent,
});
