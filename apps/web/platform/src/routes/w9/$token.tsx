import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/w9/page';

export const Route = createFileRoute('/w9/$token')({
  component: PageComponent,
});
