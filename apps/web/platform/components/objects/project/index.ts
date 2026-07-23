import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const ProjectPanel = lazy(() =>
  import('./project-panel').then((m) => ({ default: m.ProjectPanel })),
);

registerObjectPanel({
  type: 'project',
  label: 'Project',
  component: ProjectPanel,
});

export { ProjectPanel };
