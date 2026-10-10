import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/partner/requests-page';

export const Route = createFileRoute('/partner/requests/')({
  component: PageComponent,
});
