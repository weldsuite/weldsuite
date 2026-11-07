import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { STAKEHOLDER_PANEL_TYPE } from '@/app/weldflow/project/[projectId]/governance/stakeholders/_components/stakeholder-panel-type';

// Lazy-loaded so the panel body only ships when a stakeholder is opened.
const StakeholderPanel = lazy(() =>
  import('@/app/weldflow/project/[projectId]/governance/stakeholders/_components/stakeholder-panel').then((m) => ({
    default: m.StakeholderPanel,
  })),
);

registerObjectPanel({
  type: STAKEHOLDER_PANEL_TYPE,
  label: 'Stakeholder',
  component: StakeholderPanel,
});
