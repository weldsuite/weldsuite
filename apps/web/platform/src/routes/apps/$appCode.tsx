import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldapps/host/page';

export const Route = createFileRoute('/apps/$appCode')({
  component: PageComponent,
});
