import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldpanel/page';
import { parseSettingsSearch } from '@/app/settings/apps/weldpanel/search';

export const Route = createFileRoute('/settings/apps/weldpanel')({
  validateSearch: parseSettingsSearch,
  component: PageComponent,
});
