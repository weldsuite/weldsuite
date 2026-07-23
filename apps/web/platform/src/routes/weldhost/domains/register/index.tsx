import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhost/domains/register/page';

export const Route = createFileRoute('/weldhost/domains/register/')({
  component: PageComponent,
});
