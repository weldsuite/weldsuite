import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/preview/help-docs/page';

export const Route = createFileRoute('/preview/help-docs/')({
  component: PageComponent,
});
