import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/partner/page';

export const Route = createFileRoute('/partner/')({
  component: PageComponent,
});
