import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/received-nfe/page';

export const Route = createFileRoute('/weldbooks/received-nfe/')({
  component: PageComponent,
});
