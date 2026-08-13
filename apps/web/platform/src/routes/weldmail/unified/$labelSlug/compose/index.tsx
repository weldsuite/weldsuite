import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/unified/[labelSlug]/compose/page';
import { parseMailSearch } from '@/app/weldmail/lib/mail-urls';

export const Route = createFileRoute('/weldmail/unified/$labelSlug/compose/')({
  validateSearch: (search: Record<string, unknown>) => ({
    ...parseMailSearch(search),
    draftId: typeof search.draftId === 'string' ? search.draftId : undefined,
    inReplyTo: typeof search.inReplyTo === 'string' ? search.inReplyTo : undefined,
    returnUrl: typeof search.returnUrl === 'string' ? search.returnUrl : undefined,
  }),
  component: PageComponent,
});
