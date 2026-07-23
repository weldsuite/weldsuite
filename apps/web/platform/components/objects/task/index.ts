import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const TaskPanel = lazy(() =>
  import('./task-panel').then((m) => ({ default: m.TaskPanel })),
);

registerObjectPanel({
  type: 'task',
  label: 'Task',
  component: TaskPanel,
});

export { TaskPanel };
