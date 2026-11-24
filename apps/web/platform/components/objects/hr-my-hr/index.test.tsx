import { Suspense, type ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  MY_ANNOUNCEMENT_PANEL_TYPE,
  MY_ATTENDANCE_PANEL_TYPE,
  MY_COACHING_PANEL_TYPE,
  MY_DECLARATION_PANEL_TYPE,
  MY_EVALUATION_PANEL_TYPE,
  MY_KPI_PANEL_TYPE,
  MY_LEAVE_BALANCE_PANEL_TYPE,
  MY_LEAVE_REQUEST_PANEL_TYPE,
  MY_MILESTONE_PANEL_TYPE,
  MY_OPEN_SHIFT_PANEL_TYPE,
  MY_SHIFT_PANEL_TYPE,
  MY_SICK_REPORT_PANEL_TYPE,
} from './types';

interface Registration {
  type: string;
  label: string;
  component: ComponentType<{
    id: string;
    isOpen: boolean;
    onClose: () => void;
  }>;
}

const mocks = vi.hoisted(() => ({ registered: [] as unknown[] }));

vi.mock('@/components/object-panel', () => ({
  registerObjectPanel: (registration: unknown) => mocks.registered.push(registration),
}));
// The panel bodies have tests of their own; each stand-in shows which one was loaded.
vi.mock('./my-leave-request-panel', () => ({
  MyLeaveRequestPanel: () => <p>leave request body</p>,
}));
vi.mock('./my-leave-balance-panel', () => ({
  MyLeaveBalancePanel: () => <p>leave balance body</p>,
}));
vi.mock('./my-sick-report-panel', () => ({
  MySickReportPanel: () => <p>sick report body</p>,
}));
vi.mock('./my-declaration-panel', () => ({
  MyDeclarationPanel: () => <p>declaration body</p>,
}));
vi.mock('./my-announcement-panel', () => ({
  MyAnnouncementPanel: () => <p>announcement body</p>,
}));
vi.mock('./my-shift-panel', () => ({ MyShiftPanel: () => <p>shift body</p> }));
vi.mock('./my-open-shift-panel', () => ({
  MyOpenShiftPanel: () => <p>open shift body</p>,
}));
vi.mock('./my-attendance-panel', () => ({
  MyAttendancePanel: () => <p>attendance body</p>,
}));
vi.mock('./my-review-panels', () => ({
  MyEvaluationPanel: () => <p>evaluation body</p>,
  MyCoachingPanel: () => <p>coaching body</p>,
  MyKpiPanel: () => <p>kpi body</p>,
  MyMilestonePanel: () => <p>milestone body</p>,
}));

import './index';

const expected: Array<[string, string, string]> = [
  [MY_LEAVE_REQUEST_PANEL_TYPE, 'Leave request', 'leave request body'],
  [MY_LEAVE_BALANCE_PANEL_TYPE, 'Leave balance', 'leave balance body'],
  [MY_SICK_REPORT_PANEL_TYPE, 'Sick report', 'sick report body'],
  [MY_DECLARATION_PANEL_TYPE, 'Declaration', 'declaration body'],
  [MY_ANNOUNCEMENT_PANEL_TYPE, 'Announcement', 'announcement body'],
  [MY_SHIFT_PANEL_TYPE, 'Shift', 'shift body'],
  [MY_OPEN_SHIFT_PANEL_TYPE, 'Open shift', 'open shift body'],
  [MY_ATTENDANCE_PANEL_TYPE, 'Clock record', 'attendance body'],
  [MY_EVALUATION_PANEL_TYPE, 'Evaluation', 'evaluation body'],
  [MY_COACHING_PANEL_TYPE, 'Coaching session', 'coaching body'],
  [MY_KPI_PANEL_TYPE, 'KPI', 'kpi body'],
  [MY_MILESTONE_PANEL_TYPE, 'Milestone', 'milestone body'],
];

describe('My HR object panels', () => {
  it('registers one panel per type, with its label', () => {
    const registrations = mocks.registered as Registration[];
    expect(registrations.map((r) => [r.type, r.label])).toEqual(expected.map(([type, label]) => [type, label]));
  });

  it.each(expected)('loads the %s panel body when it is opened', async (type, _label, body) => {
    const registration = (mocks.registered as Registration[]).find((r) => r.type === type);
    if (!registration) throw new Error(`${type} is not registered`);
    const Panel = registration.component;
    render(
      <Suspense fallback={<p>loading</p>}>
        <Panel id="item_1" isOpen onClose={() => {}} />
      </Suspense>,
    );
    expect(await screen.findByText(body)).toBeInTheDocument();
  });
});
