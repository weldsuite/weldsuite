import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/appstore/page';

export const Route = createFileRoute('/appstore/')({
  component: PageComponent,
});
