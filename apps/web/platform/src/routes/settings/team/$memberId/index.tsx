import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/team/[memberId]/page';

export const Route = createFileRoute('/settings/team/$memberId/')({
  component: PageComponent,
});
