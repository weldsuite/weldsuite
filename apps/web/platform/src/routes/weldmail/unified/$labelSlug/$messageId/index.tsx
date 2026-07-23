import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/unified/[labelSlug]/[messageId]/page';

export const Route = createFileRoute('/weldmail/unified/$labelSlug/$messageId/')({
  component: PageComponent,
});
