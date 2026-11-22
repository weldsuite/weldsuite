import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { MY_LEAVE_BALANCE_PANEL_TYPE, MY_LEAVE_REQUEST_PANEL_TYPE, MY_SICK_REPORT_PANEL_TYPE } from './types';

// Lazy-loaded so the panel bodies only ship when one is opened (the object-panel
// host wraps the renderer in <Suspense>).
const MyLeaveRequestPanel = lazy(() =>
  import('./my-leave-request-panel').then((m) => ({ default: m.MyLeaveRequestPanel })),
);
const MyLeaveBalancePanel = lazy(() =>
  import('./my-leave-balance-panel').then((m) => ({ default: m.MyLeaveBalancePanel })),
);
const MySickReportPanel = lazy(() => import('./my-sick-report-panel').then((m) => ({ default: m.MySickReportPanel })));

registerObjectPanel({ type: MY_LEAVE_REQUEST_PANEL_TYPE, label: 'Leave request', component: MyLeaveRequestPanel });
registerObjectPanel({ type: MY_LEAVE_BALANCE_PANEL_TYPE, label: 'Leave balance', component: MyLeaveBalancePanel });
registerObjectPanel({ type: MY_SICK_REPORT_PANEL_TYPE, label: 'Sick report', component: MySickReportPanel });
