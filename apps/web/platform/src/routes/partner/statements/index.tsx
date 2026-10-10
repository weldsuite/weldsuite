import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/partner/statements/page';

export const Route = createFileRoute('/partner/statements/')({
  component: PageComponent,
});
