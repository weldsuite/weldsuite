import { resolveAccess } from '../access';

describe('resolveAccess', () => {
  it('gives an employee My HR and no Team tab', () => {
    const access = resolveAccess({ permissions: ['employees:self'] }, false);
    expect(access.self).toBe(true);
    expect(access.team).toBe(false);
  });

  it('opens approvals only with both read and approve', () => {
    const readOnly = resolveAccess({ permissions: ['employees:self', 'leave:read'] }, false);
    expect(readOnly.approveLeave).toBe(false);
    // leave:read alone still opens the "today" overview, so the tab shows.
    expect(readOnly.teamToday).toBe(true);
    expect(readOnly.team).toBe(true);

    const manager = resolveAccess(
      { permissions: ['employees:self', 'leave:read', 'leave:approve', 'declarations:read', 'declarations:approve'] },
      false,
    );
    expect(manager.approveLeave).toBe(true);
    expect(manager.approveExpenses).toBe(true);
  });

  it('opens the team views per endpoint permission', () => {
    const planner = resolveAccess({ permissions: ['employees:self', 'attendance:read'] }, false);
    expect(planner.attendance).toBe(true);
    expect(planner.leave).toBe(false);

    const employee = resolveAccess({ permissions: ['employees:self'] }, false);
    expect(employee.attendance).toBe(false);
    expect(employee.leave).toBe(false);
  });

  it('honours wildcards and denies', () => {
    const admin = resolveAccess({ permissions: ['*'] }, false);
    expect(admin).toMatchObject({ self: true, approveLeave: true, approveExpenses: true, directory: true, sickToday: true });

    const denied = resolveAccess({ permissions: ['*'], denies: ['leave:approve'] }, false);
    expect(denied.approveLeave).toBe(false);
    expect(denied.approveExpenses).toBe(true);
  });

  it('checks WeldHR-scoped grants once per-app permissions are enforced', () => {
    const scoped = resolveAccess({ permissions: ['weldhr:employees:self', 'weldhr:employees:read'] }, true);
    expect(scoped.self).toBe(true);
    expect(scoped.directory).toBe(true);
  });
});
