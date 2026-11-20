import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/page';

export const Route = createFileRoute('/preview/weldforms/')({
  component: PageComponent,
});
