import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/partner/packages-page';

export const Route = createFileRoute('/partner/packages/')({
  component: PageComponent,
});
