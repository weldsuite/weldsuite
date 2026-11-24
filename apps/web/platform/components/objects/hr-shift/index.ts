import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { HR_SHIFT_PANEL_TYPE, HR_SHIFT_REQUEST_PANEL_TYPE } from './types';

// Lazy-loaded so the panel body only ships when one is opened (the object-panel
// host wraps the renderer in <Suspense>).
const HrShiftPanel = lazy(() => import('./hr-shift-panel').then((m) => ({ default: m.HrShiftPanel })));
const HrShiftRequestPanel = lazy(() => import('./hr-shift-request-panel').then((m) => ({ default: m.HrShiftRequestPanel })));

registerObjectPanel({ type: HR_SHIFT_PANEL_TYPE, label: 'Shift', component: HrShiftPanel });
registerObjectPanel({ type: HR_SHIFT_REQUEST_PANEL_TYPE, label: 'Shift request', component: HrShiftRequestPanel });
