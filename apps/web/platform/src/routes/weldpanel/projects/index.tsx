import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/projects/page';

export const Route = createFileRoute('/weldpanel/projects/')({
  component: PageComponent,
});
