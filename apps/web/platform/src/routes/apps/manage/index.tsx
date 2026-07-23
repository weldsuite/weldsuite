import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldapps/manage/page';

export const Route = createFileRoute('/apps/manage/')({
  component: PageComponent,
});
