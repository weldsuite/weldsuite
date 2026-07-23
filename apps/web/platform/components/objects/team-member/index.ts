import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const TeamMemberPanel = lazy(() =>
  import('./team-member-panel').then((m) => ({ default: m.TeamMemberPanel })),
);

registerObjectPanel({
  type: 'team-member',
  label: 'TeamMember',
  component: TeamMemberPanel,
});

;
