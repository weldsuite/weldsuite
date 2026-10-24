import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldsign/page';

export const Route = createFileRoute('/weldsign/')({
  component: PageComponent,
});
