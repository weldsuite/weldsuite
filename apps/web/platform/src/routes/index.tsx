import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/home-page';

export const Route = createFileRoute('/')({
  component: PageComponent,
});
