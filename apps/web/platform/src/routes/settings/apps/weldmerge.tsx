import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldmerge/page';
import { validateWeldMergeSettingsSearch } from '@/app/weldmerge/lib/settings-path';

export const Route = createFileRoute('/settings/apps/weldmerge')({
  validateSearch: validateWeldMergeSettingsSearch,
  component: PageComponent,
});
