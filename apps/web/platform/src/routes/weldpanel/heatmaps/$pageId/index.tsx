import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/heatmaps/detail/page';

export const Route = createFileRoute('/weldpanel/heatmaps/$pageId/')({
  component: PageComponent,
});
