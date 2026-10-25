import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldsign/templates/page';

export const Route = createFileRoute('/weldsign/templates/')({
  component: PageComponent,
});
