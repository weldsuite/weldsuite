import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/appstore/[code]/page';

export const Route = createFileRoute('/appstore/$code/')({
  component: PageComponent,
});
