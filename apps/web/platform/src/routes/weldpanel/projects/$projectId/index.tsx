import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/project/page';

export const Route = createFileRoute('/weldpanel/projects/$projectId/')({
  component: PageComponent,
});
