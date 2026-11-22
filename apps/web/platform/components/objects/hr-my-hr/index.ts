import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import {
  MY_ANNOUNCEMENT_PANEL_TYPE,
  MY_ATTENDANCE_PANEL_TYPE,
  MY_COACHING_PANEL_TYPE,
  MY_EVALUATION_PANEL_TYPE,
  MY_KPI_PANEL_TYPE,
  MY_MILESTONE_PANEL_TYPE,
  MY_DECLARATION_PANEL_TYPE,
  MY_LEAVE_BALANCE_PANEL_TYPE,
  MY_LEAVE_REQUEST_PANEL_TYPE,
  MY_OPEN_SHIFT_PANEL_TYPE,
  MY_SHIFT_PANEL_TYPE,
  MY_SICK_REPORT_PANEL_TYPE,
} from './types';

// Lazy-loaded so the panel bodies only ship when one is opened (the object-panel
// host wraps the renderer in <Suspense>).
const MyLeaveRequestPanel = lazy(() =>
  import('./my-leave-request-panel').then((m) => ({ default: m.MyLeaveRequestPanel })),
);
const MyLeaveBalancePanel = lazy(() =>
  import('./my-leave-balance-panel').then((m) => ({ default: m.MyLeaveBalancePanel })),
);
const MySickReportPanel = lazy(() => import('./my-sick-report-panel').then((m) => ({ default: m.MySickReportPanel })));
const MyDeclarationPanel = lazy(() =>
  import('./my-declaration-panel').then((m) => ({ default: m.MyDeclarationPanel })),
);
const MyAnnouncementPanel = lazy(() =>
  import('./my-announcement-panel').then((m) => ({ default: m.MyAnnouncementPanel })),
);
const MyShiftPanel = lazy(() => import('./my-shift-panel').then((m) => ({ default: m.MyShiftPanel })));
const MyOpenShiftPanel = lazy(() => import('./my-open-shift-panel').then((m) => ({ default: m.MyOpenShiftPanel })));
const MyAttendancePanel = lazy(() => import('./my-attendance-panel').then((m) => ({ default: m.MyAttendancePanel })));
const reviewPanels = () => import('./my-review-panels');
const MyEvaluationPanel = lazy(() => reviewPanels().then((m) => ({ default: m.MyEvaluationPanel })));
const MyCoachingPanel = lazy(() => reviewPanels().then((m) => ({ default: m.MyCoachingPanel })));
const MyKpiPanel = lazy(() => reviewPanels().then((m) => ({ default: m.MyKpiPanel })));
const MyMilestonePanel = lazy(() => reviewPanels().then((m) => ({ default: m.MyMilestonePanel })));

registerObjectPanel({ type: MY_LEAVE_REQUEST_PANEL_TYPE, label: 'Leave request', component: MyLeaveRequestPanel });
registerObjectPanel({ type: MY_LEAVE_BALANCE_PANEL_TYPE, label: 'Leave balance', component: MyLeaveBalancePanel });
registerObjectPanel({ type: MY_SICK_REPORT_PANEL_TYPE, label: 'Sick report', component: MySickReportPanel });
registerObjectPanel({ type: MY_DECLARATION_PANEL_TYPE, label: 'Declaration', component: MyDeclarationPanel });
registerObjectPanel({ type: MY_ANNOUNCEMENT_PANEL_TYPE, label: 'Announcement', component: MyAnnouncementPanel });
registerObjectPanel({ type: MY_SHIFT_PANEL_TYPE, label: 'Shift', component: MyShiftPanel });
registerObjectPanel({ type: MY_OPEN_SHIFT_PANEL_TYPE, label: 'Open shift', component: MyOpenShiftPanel });
registerObjectPanel({ type: MY_ATTENDANCE_PANEL_TYPE, label: 'Clock record', component: MyAttendancePanel });
registerObjectPanel({ type: MY_EVALUATION_PANEL_TYPE, label: 'Evaluation', component: MyEvaluationPanel });
registerObjectPanel({ type: MY_COACHING_PANEL_TYPE, label: 'Coaching session', component: MyCoachingPanel });
registerObjectPanel({ type: MY_KPI_PANEL_TYPE, label: 'KPI', component: MyKpiPanel });
registerObjectPanel({ type: MY_MILESTONE_PANEL_TYPE, label: 'Milestone', component: MyMilestonePanel });
