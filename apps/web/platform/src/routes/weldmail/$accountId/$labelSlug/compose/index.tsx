import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/[accountId]/[labelSlug]/compose/page';

export const Route = createFileRoute('/weldmail/$accountId/$labelSlug/compose/')({
  component: PageComponent,
});
