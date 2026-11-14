import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/recordings/page';
import { parseRecordingsSearch } from '@/app/weldpanel/lib/recordings-search';

export const Route = createFileRoute('/weldpanel/recordings/')({
  validateSearch: parseRecordingsSearch,
  component: PageComponent,
});
