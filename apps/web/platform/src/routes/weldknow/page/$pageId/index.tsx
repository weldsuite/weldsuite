import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldknow/page/page';

export const Route = createFileRoute('/weldknow/page/$pageId/')({
  component: PageComponent,
});
