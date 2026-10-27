// The real query client pulls in Clerk through @weldsuite/mobile-realtime; only the keys matter here.
jest.mock('../query-client', () => ({ weldhrKeys: { all: ['weldhr'] } }));

import { appSyncMap } from '../sync-map';

describe('appSyncMap', () => {
  it('refreshes WeldHR screens for the HR events a member can see change', () => {
    for (const topic of ['hr_leave_request', 'hr_shift_request', 'hr_declaration', 'hr_absence', 'hr_attendance', 'hr_payslip']) {
      expect(appSyncMap[topic]).toBeDefined();
    }
  });

  it('only listens to hr_* topics', () => {
    expect(Object.keys(appSyncMap).every((topic) => topic.startsWith('hr_'))).toBe(true);
  });
});
