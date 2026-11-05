import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { DECISION_PANEL_TYPE } from '@/app/weldflow/project/[projectId]/governance/decisions/_components/decision-panel-type';

// Lazy-loaded so the panel body only ships when a decision is opened.
const DecisionPanel = lazy(() =>
  import('@/app/weldflow/project/[projectId]/governance/decisions/_components/decision-panel').then((m) => ({ default: m.DecisionPanel })),
);

registerObjectPanel({
  type: DECISION_PANEL_TYPE,
  label: 'Decision',
  component: DecisionPanel,
});
