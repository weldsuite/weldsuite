import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/roles/[roleId]/page';

export const Route = createFileRoute('/settings/roles/$roleId/')({
  component: PageComponent,
});
