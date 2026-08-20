import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/[accountId]/[labelSlug]/[messageId]/page';
import { parseMailSearch } from '@/app/weldmail/lib/mail-urls';

export const Route = createFileRoute('/weldmail/$accountId/$labelSlug/$messageId/')({
  validateSearch: parseMailSearch,
  component: PageComponent,
});
