import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/[accountId]/[labelSlug]/page';

export const Route = createFileRoute('/weldmail/$accountId/$labelSlug/')({
  component: PageComponent,
});
