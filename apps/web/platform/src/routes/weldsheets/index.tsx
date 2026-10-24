import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldsheets/page';

export const Route = createFileRoute('/weldsheets/')({
  component: PageComponent,
});
