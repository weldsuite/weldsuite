import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { CHANGE_REQUEST_PANEL_TYPE } from '@/app/weldflow/project/[projectId]/governance/changes/_components/change-panel-type';

// Lazy-loaded so the panel body only ships when a change request is opened.
const ChangeRequestPanel = lazy(() =>
  import('@/app/weldflow/project/[projectId]/governance/changes/_components/change-panel').then((m) => ({ default: m.ChangeRequestPanel })),
);

registerObjectPanel({
  type: CHANGE_REQUEST_PANEL_TYPE,
  label: 'Change request',
  component: ChangeRequestPanel,
});
