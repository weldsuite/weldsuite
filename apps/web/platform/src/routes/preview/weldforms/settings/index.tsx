import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/settings/page';

export const Route = createFileRoute('/preview/weldforms/settings/')({
  component: PageComponent,
});
