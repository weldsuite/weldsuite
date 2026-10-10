import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/partner/settings-page';

export const Route = createFileRoute('/partner/settings/')({
  component: PageComponent,
});
