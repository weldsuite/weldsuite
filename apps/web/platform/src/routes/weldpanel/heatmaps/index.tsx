import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/heatmaps/page';

export const Route = createFileRoute('/weldpanel/heatmaps/')({
  component: PageComponent,
});
