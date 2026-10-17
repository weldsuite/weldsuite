import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const PayrollRunPanel = lazy(() =>
  import('./payroll-run-panel').then((m) => ({ default: m.PayrollRunPanel })),
);

registerObjectPanel({
  type: 'payroll_run',
  label: 'Payroll run',
  component: PayrollRunPanel,
});

export { PayrollRunPanel };
