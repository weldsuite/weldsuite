import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldsheets/page';

export const Route = createFileRoute('/preview/weldsheets/')({
  component: PageComponent,
});
