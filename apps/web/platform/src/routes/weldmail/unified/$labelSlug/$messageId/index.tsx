import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/unified/[labelSlug]/[messageId]/page';
import { parseMailSearch } from '@/app/weldmail/lib/mail-urls';

export const Route = createFileRoute('/weldmail/unified/$labelSlug/$messageId/')({
  validateSearch: parseMailSearch,
  component: PageComponent,
});
