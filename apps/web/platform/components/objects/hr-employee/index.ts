import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { HR_EMPLOYEE_PANEL_TYPE } from './hr-employee-tabs';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const HrEmployeePanel = lazy(() =>
  import('./hr-employee-panel').then((m) => ({ default: m.HrEmployeePanel })),
);

registerObjectPanel({
  type: HR_EMPLOYEE_PANEL_TYPE,
  label: 'Employee',
  component: HrEmployeePanel,
});
