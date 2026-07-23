import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/[accountId]/[labelSlug]/[messageId]/page';

export const Route = createFileRoute('/weldmail/$accountId/$labelSlug/$messageId/')({
  component: PageComponent,
});
