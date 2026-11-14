import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/settings/page';
import { parseSettingsSearch } from '@/app/weldpanel/settings/search';

export const Route = createFileRoute('/weldpanel/settings/')({
  validateSearch: parseSettingsSearch,
  component: PageComponent,
});
