import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/lexicon/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/lexicon/')({
  staticData: { breadcrumb: { labelKey: 'lexicon' } },
  component: PageComponent,
});
