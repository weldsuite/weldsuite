/**
 * Route tests for the WeldHR directory: /dashboard, /employees, /org-chart,
 * /departments, /assignments, /clients and /settings, against a real pglite
 * tenant database through the whole /api/weldhr router.
 *
 * These are the requests the Rust port (rust/modules/hr) is compared on in
 * conformance mode, refusals included.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  HR_ADMIN,
  daysFromToday,
  data,
  errorOf,
  hrCaller,
  hrDb,
  resetHr,
  seedCompany,
  seedDepartment,
  seedEmployee,
  seedMember,
  today,
} from '../../test/hr-fixtures';

let db: Database;

beforeAll(async () => {
  db = await hrDb();
}, 60_000);

beforeEach(async () => {
  await resetHr(db);
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, 'user_alice', { name: 'Alice Anders', email: 'alice@example.com', title: 'Engineer', phone: '+3211' });
  await seedMember(db, 'user_bob', { name: 'Bob Berg', email: 'bob@example.com' });
  await seedMember(db, 'user_erin', { name: 'Erin Employee', email: 'erin@example.com', memberType: 'EMPLOYEE' });
  await seedMember(db, 'user_gus', { name: 'Gus Guest', email: 'gus@example.com', memberType: 'EXTERNAL_GUEST' });
  await seedMember(db, 'invited_pia@example.com', { id: 'wm_invited_pia', name: 'Pia Pending', email: 'pia@example.com', status: 'PENDING' });
});

const admin = () => hrCaller(db);
const as = (...grants: string[]) => hrCaller(db, { grants });

async function auditActions(employeeId: string) {
  const rows = await db.select().from(schema.hrAuditEvents).where(eq(schema.hrAuditEvents.employeeId, employeeId));
  return rows.map((r) => r.action).sort();
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

describe('GET /dashboard', () => {
  it('rolls up headcount, today, lifecycle, leave, coaching, evaluations and clients', async () => {
    await seedCompany(db, 'co_acme', 'Acme');
    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com', firstName: 'Ann' });
    await seedEmployee(db, { id: 'hremp_ben', status: 'onboarding', startDate: daysFromToday(10), email: 'ben@example.com', firstName: 'Ben' });
    await seedEmployee(db, { id: 'hremp_old', status: 'terminated', email: 'old@example.com', firstName: 'Old' });
    await db.insert(schema.hrClientAssignments).values({
      id: 'hrasg_d1',
      employeeId: 'hremp_ann',
      companyId: 'co_acme',
      startDate: daysFromToday(-30),
      allocationPercent: 50,
    });
    await db.insert(schema.hrAttendanceRecords).values({
      id: 'hratt_d1',
      employeeId: 'hremp_ann',
      date: today(),
      clockIn: new Date(Date.now() - 3600_000),
      status: 'present',
    });
    await db.insert(schema.hrLeaveRequests).values([
      { id: 'hrlvr_d1', employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_default_annual', startDate: daysFromToday(-1), endDate: daysFromToday(1), days: 2, status: 'approved' },
      { id: 'hrlvr_d2', employeeId: 'hremp_ben', leaveTypeId: 'hrlvt_default_annual', startDate: daysFromToday(40), endDate: daysFromToday(41), days: 2, status: 'pending' },
    ]);
    await db.insert(schema.hrChecklists).values({ id: 'hrchk_d1', employeeId: 'hremp_ben', kind: 'onboarding', name: 'Onboarding' });
    await db.insert(schema.hrChecklistTasks).values([
      { id: 'hrtsk_d1', checklistId: 'hrchk_d1', employeeId: 'hremp_ben', title: 'Overdue', dueDate: daysFromToday(-2) },
      { id: 'hrtsk_d2', checklistId: 'hrchk_d1', employeeId: 'hremp_ben', title: 'Later', dueDate: daysFromToday(5) },
    ]);
    await db.insert(schema.hrCoachingLogs).values({
      id: 'hrcch_d1',
      employeeId: 'hremp_ann',
      sessionDate: daysFromToday(-10),
      topic: 'Follow up',
      followUpDate: daysFromToday(-1),
    });
    await db.insert(schema.hrEvaluations).values({
      id: 'hrevl_d1',
      employeeId: 'hremp_ann',
      formId: 'hrevf_default_scorecard',
      status: 'submitted',
      overallScore: 82.5,
      submittedAt: new Date(Date.now() - 86_400_000),
    });

    const res = await admin().get('/dashboard');
    expect(res.status).toBe(200);
    const body = await data<{
      headcount: { total: number; byStatus: Record<string, number> };
      today: { clockedIn: number; onLeave: Array<{ employeeId: string }> };
      lifecycle: { openTasks: number; overdueTasks: number; upcomingStarts: Array<{ id: string }> };
      pendingLeaveRequests: number;
      coachingFollowUpsDue: number;
      evaluations: { averageScore90d: number | null; recent: Array<{ id: string; employeeName: string }> };
      clients: Array<{ companyId: string; fte: number }>;
    }>(res);
    expect(body.headcount).toEqual({ total: 2, byStatus: { active: 1, onboarding: 1, terminated: 1 } });
    expect(body.today.clockedIn).toBe(1);
    expect(body.today.onLeave.map((l) => l.employeeId)).toEqual(['hremp_ann']);
    expect(body.lifecycle).toMatchObject({ openTasks: 2, overdueTasks: 1 });
    expect(body.lifecycle.upcomingStarts.map((s) => s.id)).toEqual(['hremp_ben']);
    expect(body.pendingLeaveRequests).toBe(1);
    expect(body.coachingFollowUpsDue).toBe(1);
    expect(body.evaluations.averageScore90d).toBe(82.5);
    expect(body.evaluations.recent[0]).toMatchObject({ id: 'hrevl_d1', employeeName: 'Ann Example' });
    expect(body.clients).toEqual([{ companyId: 'co_acme', companyName: 'Acme', activeCount: 1, totalCount: 1, fte: 0.5 }]);
  });

  it('answers an empty workspace', async () => {
    const res = await admin().get('/dashboard');
    expect(res.status).toBe(200);
    const body = await data<{ headcount: { total: number }; evaluations: { averageScore90d: number | null } }>(res);
    expect(body.headcount.total).toBe(0);
    expect(body.evaluations.averageScore90d).toBeNull();
  });

  it('is refused without any of the HR read grants', async () => {
    const res = await as('announcements:read').get('/dashboard');
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

describe('GET /employees', () => {
  beforeEach(async () => {
    await seedDepartment(db, 'hrdep_ops', 'Operations');
    await seedCompany(db, 'co_acme', 'Acme');
    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com', firstName: 'Ann', lastName: 'Anders', departmentId: 'hrdep_ops', jobTitle: 'Agent' });
    await seedEmployee(db, { id: 'hremp_ben', userId: 'user_bob', email: 'bob@example.com', firstName: 'Ben', lastName: 'Berg', managerId: 'hremp_ann', status: 'onboarding' });
    await seedEmployee(db, { id: 'hremp_cas', email: 'cas@example.com', firstName: 'Cas', lastName: 'Claes', preferredName: 'Cassie', status: 'terminated' });
    await db.insert(schema.hrClientAssignments).values({ id: 'hrasg_e1', employeeId: 'hremp_ben', companyId: 'co_acme', startDate: daysFromToday(-5), isPrimary: true });
  });

  it('lists the directory by last name with department, manager and clients', async () => {
    const res = await admin().get('/employees');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; departmentName: string | null; managerName: string | null; clients: unknown[]; hasSensitive: boolean; displayName: string }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(body.data.map((e) => e.id)).toEqual(['hremp_ann', 'hremp_ben', 'hremp_cas']);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
    expect(body.data[0]).toMatchObject({ departmentName: 'Operations', managerName: null, hasSensitive: false });
    expect(body.data[1]).toMatchObject({ managerName: 'Ann Anders', clients: [{ companyId: 'co_acme', companyName: 'Acme', isPrimary: true }] });
    expect(body.data[2]!.displayName).toBe('Cassie Claes');
    expect(body.data[0]).not.toHaveProperty('sensitiveEncrypted');
  });

  it('filters by search, status, department and client, and pages with a cursor', async () => {
    const caller = admin();
    const ids = async (query: string) => ((await (await caller.get(`/employees${query}`)).json()) as { data: Array<{ id: string }> }).data.map((e) => e.id);
    expect(await ids('?search=berg')).toEqual(['hremp_ben']);
    expect(await ids('?status=active,onboarding')).toEqual(['hremp_ann', 'hremp_ben']);
    expect(await ids('?departmentId=hrdep_ops')).toEqual(['hremp_ann']);
    expect(await ids('?companyId=co_acme')).toEqual(['hremp_ben']);
    expect(await ids('?managerId=hremp_ann')).toEqual(['hremp_ben']);

    const first = (await (await caller.get('/employees?limit=2')).json()) as { data: Array<{ id: string }>; pagination: { hasMore: boolean; cursor: string } };
    expect(first.data.map((e) => e.id)).toEqual(['hremp_ann', 'hremp_ben']);
    expect(first.pagination).toMatchObject({ hasMore: true, cursor: 'hremp_ben' });
    expect(await ids(`?limit=2&cursor=${first.pagination.cursor}`)).toEqual(['hremp_cas']);
  });

  it('links an employee whose workspace invite has been accepted', async () => {
    await seedMember(db, 'user_dirk', { name: 'Dirk Dekker', email: 'dirk@example.com' });
    await seedEmployee(db, { id: 'hremp_dirk', email: 'Dirk@example.com', firstName: 'Dirk', userId: null });

    const res = await admin().get('/employees?search=dirk', { write: true });
    expect(res.status).toBe(200);
    expect((await data<Array<{ userId: string | null }>>(res))[0]!.userId).toBe('user_dirk');
    expect(await auditActions('hremp_dirk')).toEqual(['employee.linked']);
  });

  it('refuses a bad query and a caller without employees:read', async () => {
    expect((await admin().get('/employees?limit=0')).status).toBe(400);
    expect((await as('employees:create').get('/employees')).status).toBe(403);
  });
});

describe('GET /employees/available-members', () => {
  it('lists active INTERNAL and EMPLOYEE members who are not an employee yet', async () => {
    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com' });
    const res = await admin().get('/employees/available-members');
    expect(res.status).toBe(200);
    const members = await data<Array<{ userId: string; memberType: string }>>(res);
    expect(members.map((m) => m.userId)).toEqual(['user_bob', 'user_erin', HR_ADMIN]);
    expect(members.find((m) => m.userId === 'user_erin')?.memberType).toBe('EMPLOYEE');

    const searched = await data<Array<{ userId: string }>>(await admin().get('/employees/available-members?search=erin&limit=5'));
    expect(searched.map((m) => m.userId)).toEqual(['user_erin']);
  });

  it('needs employees:create or employees:update', async () => {
    expect((await as('employees:read').get('/employees/available-members')).status).toBe(403);
    expect((await as('employees:update').get('/employees/available-members')).status).toBe(200);
  });
});

describe('GET /employees/:employeeId', () => {
  it('answers the profile with direct reports', async () => {
    await seedDepartment(db, 'hrdep_ops', 'Operations');
    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com', firstName: 'Ann', departmentId: 'hrdep_ops' });
    await seedEmployee(db, { id: 'hremp_ben', userId: 'user_bob', email: 'bob@example.com', firstName: 'Ben', managerId: 'hremp_ann', jobTitle: 'Agent' });
    const res = await admin().get('/employees/hremp_ann');
    expect(res.status).toBe(200);
    const body = await data<{ id: string; departmentName: string; directReports: Array<{ id: string; displayName: string; jobTitle: string }> }>(res);
    expect(body).toMatchObject({ id: 'hremp_ann', departmentName: 'Operations' });
    expect(body.directReports).toEqual([
      { id: 'hremp_ben', firstName: 'Ben', lastName: 'Example', preferredName: null, displayName: 'Ben Example', jobTitle: 'Agent', avatarUrl: null, status: 'active' },
    ]);
  });

  it('links an accepted invite when the profile is opened', async () => {
    await seedMember(db, 'user_dirk', { name: 'Dirk Dekker', email: 'dirk@example.com' });
    await seedEmployee(db, { id: 'hremp_dirk', email: 'dirk@example.com', userId: null });
    const res = await admin().get('/employees/hremp_dirk', { write: true });
    expect(res.status).toBe(200);
    expect((await data<{ userId: string }>(res)).userId).toBe('user_dirk');
  });

  it('is a 404 for an unknown or deleted employee', async () => {
    await seedEmployee(db, { id: 'hremp_gone', email: 'gone@example.com', deletedAt: new Date('2026-01-10T00:00:00Z') });
    const unknown = await admin().get('/employees/hremp_nope');
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe('NOT_FOUND');
    expect((await admin().get('/employees/hremp_gone')).status).toBe(404);
  });

  it('needs employees:read', async () => {
    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com' });
    expect((await as('employees:update').get('/employees/hremp_ann')).status).toBe(403);
  });
});

describe('POST /employees', () => {
  it('creates an employee linked to the member given by userId', async () => {
    const res = await admin().send('POST', '/employees', {
      firstName: 'Alice',
      lastName: 'Anders',
      email: 'alice@example.com',
      userId: 'user_alice',
      jobTitle: 'Engineer',
      weeklyHours: 32,
      startDate: '2026-02-01',
    });
    expect(res.status).toBe(201);
    const body = await data<Record<string, unknown>>(res);
    expect(body).toMatchObject({
      firstName: 'Alice',
      userId: 'user_alice',
      status: 'onboarding',
      employmentType: 'full_time',
      weeklyHours: 32,
      hasSensitive: false,
      displayName: 'Alice Anders',
      createdBy: HR_ADMIN,
    });
    expect(body).not.toHaveProperty('sensitiveEncrypted');
  });

  it('links an active member by email, and leaves someone invited unlinked until they accept', async () => {
    const active = await admin().send('POST', '/employees', { firstName: 'Bob', lastName: 'Berg', email: 'BOB@example.com' });
    expect(active.status).toBe(201);
    expect((await data<{ userId: string | null }>(active)).userId).toBe('user_bob');

    const invited = await admin().send('POST', '/employees', { firstName: 'Pia', lastName: 'Pending', email: 'pia@example.com' });
    expect(invited.status).toBe(201);
    expect((await data<{ userId: string | null }>(invited)).userId).toBeNull();
  });

  it('seals the sensitive block for a caller with employees:sensitive, and starts onboarding', async () => {
    const res = await admin().send('POST', '/employees', {
      firstName: 'Erin',
      lastName: 'Evers',
      email: 'erin@example.com',
      userId: 'user_erin',
      sensitive: { dateOfBirth: '1990-05-01', salaryAmount: 3200, salaryCurrency: 'EUR', salaryPeriod: 'month' },
      onboardingTemplateId: 'hrctp_default_onboarding',
    });
    expect(res.status).toBe(201);
    const employee = await data<{ id: string; hasSensitive: boolean }>(res);
    expect(employee.hasSensitive).toBe(true);
    expect(await auditActions(employee.id)).toEqual(['employee.sensitive_updated']);
    const checklists = await db.select().from(schema.hrChecklists).where(eq(schema.hrChecklists.employeeId, employee.id));
    expect(checklists).toHaveLength(1);
    expect(checklists[0]!.kind).toBe('onboarding');
  });

  it('refuses sensitive data from a caller without employees:sensitive', async () => {
    const res = await as('employees:create').send('POST', '/employees', {
      firstName: 'Bob',
      lastName: 'Berg',
      email: 'bob@example.com',
      sensitive: { notes: 'x' },
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe('You do not have permission to set sensitive employee data');
  });

  it('answers readable validation messages', async () => {
    const res = await admin().send('POST', '/employees', { firstName: '', lastName: 'X', email: 'not-an-email' });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('First name is required. Email must be a valid email address');
  });

  it('refuses someone who is not a member, a guest, a taken email and an unknown manager', async () => {
    const stranger = await admin().send('POST', '/employees', { firstName: 'Zed', lastName: 'Z', email: 'zed@example.com' });
    expect(stranger.status).toBe(400);
    expect((await errorOf(stranger)).message).toBe('An employee must be a member of this workspace. Invite them first.');

    const guest = await admin().send('POST', '/employees', { firstName: 'Gus', lastName: 'G', email: 'gus@example.com' });
    expect(guest.status).toBe(400);
    expect((await errorOf(guest)).message).toBe('External guests cannot be employees');

    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com' });
    const taken = await admin().send('POST', '/employees', { firstName: 'A', lastName: 'B', email: 'Alice@example.com', userId: 'user_bob' });
    expect(taken.status).toBe(409);
    expect((await errorOf(taken)).message).toBe('Another employee already uses this email address');

    const linked = await admin().send('POST', '/employees', { firstName: 'A', lastName: 'B', email: 'other@example.com', userId: 'user_alice' });
    expect(linked.status).toBe(409);

    const manager = await admin().send('POST', '/employees', { firstName: 'Bob', lastName: 'B', email: 'bob@example.com', managerId: 'hremp_nope' });
    expect(manager.status).toBe(404);

    const dates = await admin().send('POST', '/employees', {
      firstName: 'Bob',
      lastName: 'B',
      email: 'bob@example.com',
      startDate: '2026-03-01',
      endDate: '2026-02-01',
    });
    expect(dates.status).toBe(400);
    expect((await errorOf(dates)).message).toBe('Employment: end date is before start date');
  });

  it('needs employees:create', async () => {
    expect((await as('employees:update').send('POST', '/employees', { firstName: 'A', lastName: 'B', email: 'bob@example.com' })).status).toBe(403);
  });
});

describe('POST /employees/from-member', () => {
  it('prefills the employee from the workspace member', async () => {
    const res = await admin().send('POST', '/employees/from-member', { userId: 'user_alice' });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      userId: 'user_alice',
      firstName: 'Alice',
      lastName: 'Anders',
      email: 'alice@example.com',
      jobTitle: 'Engineer',
      phone: '+3211',
      status: 'onboarding',
    });
  });

  it('keeps what the caller sends over the member profile', async () => {
    const res = await admin().send('POST', '/employees/from-member', { userId: 'user_bob', firstName: 'Bobby', jobTitle: null, status: 'active' });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ firstName: 'Bobby', lastName: 'Berg', jobTitle: null, status: 'active' });
  });

  it('refuses an unknown member, an invite placeholder, a guest and a member already linked', async () => {
    expect((await admin().send('POST', '/employees/from-member', { userId: 'user_nobody' })).status).toBe(404);

    const placeholder = await admin().send('POST', '/employees/from-member', { userId: 'invited_pia@example.com' });
    expect(placeholder.status).toBe(400);
    expect((await errorOf(placeholder)).message).toBe('That is not an active workspace member');

    expect((await admin().send('POST', '/employees/from-member', { userId: 'user_gus' })).status).toBe(400);

    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'ann.other@example.com' });
    const linked = await admin().send('POST', '/employees/from-member', { userId: 'user_alice', email: 'alice.two@example.com' });
    expect(linked.status).toBe(409);
    expect((await errorOf(linked)).message).toBe('Another employee is already linked to this workspace member');
  });

  it('validates the body and needs employees:create', async () => {
    const res = await admin().send('POST', '/employees/from-member', {});
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('User id is required');
    expect((await as('employees:read').send('POST', '/employees/from-member', { userId: 'user_alice' })).status).toBe(403);
  });
});

describe('PATCH /employees/:employeeId', () => {
  beforeEach(async () => {
    await seedDepartment(db, 'hrdep_ops', 'Operations');
    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com', firstName: 'Ann' });
    await seedEmployee(db, { id: 'hremp_ben', userId: 'user_bob', email: 'bob@example.com', firstName: 'Ben', managerId: 'hremp_ann' });
  });

  it('updates the record and answers the public row', async () => {
    const res = await admin().send('PATCH', '/employees/hremp_ann', { jobTitle: 'Team lead', departmentId: 'hrdep_ops', preferredName: 'Annie' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hremp_ann', jobTitle: 'Team lead', departmentId: 'hrdep_ops', displayName: 'Annie Example' });
  });

  it('mirrors custom fields and the profile reads them back typed', async () => {
    await db.insert(schema.customFieldDefinitions).values({ id: 'cfd_hr_badge', entityType: 'employee', name: 'Badge', slug: 'badge', fieldType: 'number' });
    const res = await admin().send('PATCH', '/employees/hremp_ann', { customFields: { badge: '1042' } });
    expect(res.status).toBe(200);
    expect((await data<{ customFields: unknown }>(res)).customFields).toEqual({ badge: '1042' });
    const detail = await data<{ customFields: unknown }>(await admin().get('/employees/hremp_ann'));
    expect(detail.customFields).toEqual({ badge: 1042 });

    const bad = await admin().send('PATCH', '/employees/hremp_ann', { customFields: { badge: 'many' } });
    expect(bad.status).toBe(400);
  });

  it('refuses sensitive data, a manager loop and a taken email', async () => {
    const sensitive = await admin().send('PATCH', '/employees/hremp_ann', { sensitive: { notes: 'x' } });
    expect(sensitive.status).toBe(400);
    expect((await errorOf(sensitive)).message).toBe('Update sensitive data through PUT /employees/:employeeId/sensitive');

    const self = await admin().send('PATCH', '/employees/hremp_ann', { managerId: 'hremp_ann' });
    expect(self.status).toBe(400);
    expect((await errorOf(self)).message).toBe('An employee cannot be their own manager');

    const loop = await admin().send('PATCH', '/employees/hremp_ann', { managerId: 'hremp_ben' });
    expect(loop.status).toBe(400);
    expect((await errorOf(loop)).message).toBe('That manager reports to this employee');

    const email = await admin().send('PATCH', '/employees/hremp_ben', { email: 'ALICE@example.com' });
    expect(email.status).toBe(409);

    const member = await admin().send('PATCH', '/employees/hremp_ben', { userId: 'user_alice' });
    expect(member.status).toBe(409);

    const location = await admin().send('PATCH', '/employees/hremp_ben', { workLocationIds: ['hrloc_nope'] });
    expect(location.status).toBe(400);
    expect((await errorOf(location)).message).toBe('One of the work locations does not exist');
  });

  it('is a 404 for an unknown employee and needs employees:update', async () => {
    expect((await admin().send('PATCH', '/employees/hremp_nope', { jobTitle: 'X' })).status).toBe(404);
    expect((await as('employees:read').send('PATCH', '/employees/hremp_ann', { jobTitle: 'X' })).status).toBe(403);
    const invalid = await admin().send('PATCH', '/employees/hremp_ann', { weeklyHours: 200 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Weekly hours must be at most 168');
  });
});

describe('DELETE /employees/:employeeId', () => {
  it('soft-deletes the record and audits it', async () => {
    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com' });
    const res = await admin().send('DELETE', '/employees/hremp_ann');
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, 'hremp_ann'));
    expect(row!.deletedAt).not.toBeNull();
    expect(await auditActions('hremp_ann')).toEqual(['employee.deleted']);
    expect((await admin().send('DELETE', '/employees/hremp_ann')).status).toBe(404);
  });

  it('needs employees:delete', async () => {
    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com' });
    expect((await as('employees:update').send('DELETE', '/employees/hremp_ann')).status).toBe(403);
  });
});

describe('/employees/:employeeId/sensitive', () => {
  beforeEach(async () => {
    await seedEmployee(db, { id: 'hremp_ann', userId: 'user_alice', email: 'alice@example.com' });
  });

  it('starts empty, merges a write, clears with null, and audits every read', async () => {
    const empty = await admin().get('/employees/hremp_ann/sensitive', { write: true });
    expect(empty.status).toBe(200);
    expect(await data(empty)).toEqual({});

    const written = await admin().send('PUT', '/employees/hremp_ann/sensitive', {
      dateOfBirth: '1991-02-03',
      personalEmail: 'ann@home.example',
      salaryAmount: 4100.5,
      notes: 'Prefers mornings',
    });
    expect(written.status).toBe(200);
    expect(await data(written)).toEqual({
      dateOfBirth: '1991-02-03',
      personalEmail: 'ann@home.example',
      salaryAmount: 4100.5,
      notes: 'Prefers mornings',
    });

    const cleared = await admin().send('PUT', '/employees/hremp_ann/sensitive', { notes: null, taxId: 'NL123' });
    expect(await data(cleared)).toEqual({
      dateOfBirth: '1991-02-03',
      personalEmail: 'ann@home.example',
      salaryAmount: 4100.5,
      notes: null,
      taxId: 'NL123',
    });

    const read = await admin().get('/employees/hremp_ann/sensitive', { write: true });
    expect((await data<{ taxId: string }>(read)).taxId).toBe('NL123');
    expect((await data<{ hasSensitive: boolean }>(await admin().get('/employees/hremp_ann'))).hasSensitive).toBe(true);
    expect(await auditActions('hremp_ann')).toEqual([
      'employee.sensitive_updated',
      'employee.sensitive_updated',
      'employee.sensitive_viewed',
      'employee.sensitive_viewed',
    ]);
  });

  it('writes nothing when nothing changes', async () => {
    await admin().send('PUT', '/employees/hremp_ann/sensitive', { notes: 'Same' });
    const again = await admin().send('PUT', '/employees/hremp_ann/sensitive', { notes: 'Same' });
    expect(again.status).toBe(200);
    expect(await auditActions('hremp_ann')).toEqual(['employee.sensitive_updated']);
  });

  it('refuses without employees:sensitive, an invalid body and an unknown employee', async () => {
    expect((await as('employees:read', 'employees:update').get('/employees/hremp_ann/sensitive', { write: true })).status).toBe(403);
    expect((await as('employees:update').send('PUT', '/employees/hremp_ann/sensitive', { notes: 'x' })).status).toBe(403);
    const invalid = await admin().send('PUT', '/employees/hremp_ann/sensitive', { personalEmail: 'nope', salaryCurrency: 'EURO' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe(
      'Personal email must be a valid email address. Salary currency can be at most 3 characters',
    );
    expect((await admin().get('/employees/hremp_nope/sensitive', { write: true })).status).toBe(404);
    expect((await admin().send('PUT', '/employees/hremp_nope/sensitive', { notes: 'x' })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Org chart and departments
// ---------------------------------------------------------------------------

describe('GET /org-chart', () => {
  it('lists everyone but the terminated, by last name', async () => {
    await seedEmployee(db, { id: 'hremp_ann', email: 'ann@example.com', firstName: 'Ann', lastName: 'Zee' });
    await seedEmployee(db, { id: 'hremp_ben', email: 'ben@example.com', firstName: 'Ben', lastName: 'Alpha', managerId: 'hremp_ann' });
    await seedEmployee(db, { id: 'hremp_cas', email: 'cas@example.com', status: 'terminated' });
    const res = await admin().get('/org-chart');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual([
      { id: 'hremp_ben', firstName: 'Ben', lastName: 'Alpha', preferredName: null, displayName: 'Ben Alpha', jobTitle: null, avatarUrl: null, managerId: 'hremp_ann', departmentId: null, status: 'active' },
      { id: 'hremp_ann', firstName: 'Ann', lastName: 'Zee', preferredName: null, displayName: 'Ann Zee', jobTitle: null, avatarUrl: null, managerId: null, departmentId: null, status: 'active' },
    ]);
    expect((await as('leave:read').get('/org-chart')).status).toBe(403);
  });
});

describe('/departments', () => {
  it('lists departments with their live headcount', async () => {
    await seedDepartment(db, 'hrdep_ops', 'Operations');
    await seedDepartment(db, 'hrdep_fin', 'Finance');
    await seedEmployee(db, { id: 'hremp_ann', email: 'ann@example.com', departmentId: 'hrdep_ops' });
    await seedEmployee(db, { id: 'hremp_ben', email: 'ben@example.com', departmentId: 'hrdep_ops', status: 'terminated' });
    const res = await admin().get('/departments');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; employeeCount: number }>>(res);
    expect(rows.map((r) => [r.id, r.employeeCount])).toEqual([
      ['hrdep_fin', 0],
      ['hrdep_ops', 1],
    ]);
    expect((await as('leave:read').get('/departments')).status).toBe(403);
  });

  it('creates, renames and refuses duplicates, unknown parents and bad input', async () => {
    const created = await admin().send('POST', '/departments', { name: 'Support', description: 'Tier 1', color: '#ff0000' });
    expect(created.status).toBe(201);
    const support = await data<{ id: string; name: string; color: string }>(created);
    expect(support).toMatchObject({ name: 'Support', color: '#ff0000', parentId: null });

    const dupe = await admin().send('POST', '/departments', { name: ' support ' });
    expect(dupe.status).toBe(409);
    expect((await errorOf(dupe)).message).toBe('A department called "support" already exists');

    expect((await admin().send('POST', '/departments', { name: 'Child', parentId: 'hrdep_nope' })).status).toBe(404);
    expect((await admin().send('POST', '/departments', { name: 'Headless', headEmployeeId: 'hremp_nope' })).status).toBe(404);
    const invalid = await admin().send('POST', '/departments', { name: '', color: 'not a colour!' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Name is required. Color: Invalid');
    expect((await as('employees:update').send('POST', '/departments', { name: 'X' })).status).toBe(403);

    const renamed = await admin().send('PATCH', `/departments/${support.id}`, { name: 'Customer support' });
    expect(renamed.status).toBe(200);
    expect((await data<{ name: string }>(renamed)).name).toBe('Customer support');
  });

  it('refuses to make a department its own parent or move it under its own child', async () => {
    await seedDepartment(db, 'hrdep_top', 'Top');
    await seedDepartment(db, 'hrdep_mid', 'Middle', 'hrdep_top');
    const own = await admin().send('PATCH', '/departments/hrdep_top', { parentId: 'hrdep_top' });
    expect(own.status).toBe(400);
    expect((await errorOf(own)).message).toBe('A department cannot be its own parent');
    const under = await admin().send('PATCH', '/departments/hrdep_top', { parentId: 'hrdep_mid' });
    expect(under.status).toBe(400);
    expect((await errorOf(under)).message).toBe('A department cannot be moved under one of its own sub-departments');
    expect((await admin().send('PATCH', '/departments/hrdep_nope', { name: 'X' })).status).toBe(404);
    expect((await admin().send('PATCH', '/departments/hrdep_mid', { name: 'top' })).status).toBe(409);
    expect((await as('employees:update').send('PATCH', '/departments/hrdep_mid', { name: 'Mid' })).status).toBe(403);
  });

  it('deletes a department: its people lose it and its children move up', async () => {
    await seedDepartment(db, 'hrdep_top', 'Top');
    await seedDepartment(db, 'hrdep_mid', 'Middle', 'hrdep_top');
    await seedDepartment(db, 'hrdep_low', 'Low', 'hrdep_mid');
    await seedEmployee(db, { id: 'hremp_ann', email: 'ann@example.com', departmentId: 'hrdep_mid' });
    const res = await admin().send('DELETE', '/departments/hrdep_mid');
    expect(res.status).toBe(204);
    const [ann] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, 'hremp_ann'));
    expect(ann!.departmentId).toBeNull();
    const [low] = await db.select().from(schema.hrDepartments).where(eq(schema.hrDepartments.id, 'hrdep_low'));
    expect(low!.parentId).toBe('hrdep_top');
    expect((await admin().send('DELETE', '/departments/hrdep_mid')).status).toBe(404);
    expect((await as('employees:delete').send('DELETE', '/departments/hrdep_top')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('/settings', () => {
  it('starts with every switch on but location off, and saves changes with an audit entry', async () => {
    const res = await admin().get('/settings');
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({
      employeeSelfClockIn: true,
      clockInRequiresLocation: false,
      employeeLeaveRequests: true,
      employeeDeclarations: true,
    });

    const saved = await admin().send('PUT', '/settings', { employeeDeclarations: false, clockInRequiresLocation: true });
    expect(saved.status).toBe(200);
    expect(await data(saved)).toMatchObject({ employeeDeclarations: false, clockInRequiresLocation: true, employeeSelfClockIn: true });
    const audits = await db.select().from(schema.hrAuditEvents).where(eq(schema.hrAuditEvents.action, 'settings.updated'));
    expect(audits).toHaveLength(1);
    // The parsed body's keys, in the schema's order, not the request's.
    expect(audits[0]!.metadata).toEqual({ fields: ['clockInRequiresLocation', 'employeeDeclarations'] });
  });

  it('reads with employees:read, writes with employees:manage, and validates', async () => {
    expect((await as('leave:read').get('/settings')).status).toBe(403);
    expect((await as('employees:read').send('PUT', '/settings', { employeeSelfClockIn: false })).status).toBe(403);
    const invalid = await admin().send('PUT', '/settings', { employeeSelfClockIn: 'yes' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Employee self clock in has the wrong type');
  });
});

// ---------------------------------------------------------------------------
// Client assignments and client accounts
// ---------------------------------------------------------------------------

describe('/assignments', () => {
  beforeEach(async () => {
    await seedCompany(db, 'co_acme', 'Acme');
    await seedCompany(db, 'co_beta', 'Beta');
    await seedCompany(db, 'co_gone', 'Gone Ltd', new Date('2026-01-02T00:00:00Z'));
    await seedEmployee(db, { id: 'hremp_ann', email: 'ann@example.com', firstName: 'Ann', jobTitle: 'Agent' });
    await seedEmployee(db, { id: 'hremp_ben', email: 'ben@example.com', firstName: 'Ben' });
    await db.insert(schema.hrClientAssignments).values([
      { id: 'hrasg_a1', employeeId: 'hremp_ann', companyId: 'co_acme', startDate: daysFromToday(-60), isPrimary: true, allocationPercent: 60 },
      { id: 'hrasg_a2', employeeId: 'hremp_ann', companyId: 'co_beta', startDate: daysFromToday(-90), endDate: daysFromToday(-10), allocationPercent: 40 },
      { id: 'hrasg_a3', employeeId: 'hremp_ben', companyId: 'co_gone', startDate: daysFromToday(-20) },
    ]);
  });

  it('lists assignments newest first, marking ended ones and deleted companies', async () => {
    const res = await admin().get('/assignments');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; isActive: boolean; companyDeleted: boolean; employeeName: string; companyName: string }>>(res);
    expect(rows.map((r) => [r.id, r.isActive, r.companyDeleted])).toEqual([
      ['hrasg_a3', false, true],
      ['hrasg_a1', true, false],
      ['hrasg_a2', false, false],
    ]);
    expect(rows[1]).toMatchObject({ employeeName: 'Ann Example', companyName: 'Acme', employeeJobTitle: 'Agent', employeeStatus: 'active' });

    const active = await data<Array<{ id: string }>>(await admin().get('/assignments?active=true'));
    expect(active.map((r) => r.id)).toEqual(['hrasg_a1']);
    const ann = await data<Array<{ id: string }>>(await admin().get('/assignments?employeeId=hremp_ann&companyId=co_beta'));
    expect(ann.map((r) => r.id)).toEqual(['hrasg_a2']);
    expect((await as('leave:read').get('/assignments')).status).toBe(403);
  });

  it('creates an assignment, moving the primary flag, and refuses overlaps and deleted companies', async () => {
    const res = await admin().send('POST', '/assignments', {
      employeeId: 'hremp_ann',
      companyId: 'co_beta',
      role: 'Lead',
      allocationPercent: 40,
      isPrimary: true,
      startDate: today(),
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ employeeId: 'hremp_ann', companyId: 'co_beta', isPrimary: true, allocationPercent: 40, createdBy: HR_ADMIN });
    const [acme] = await db.select().from(schema.hrClientAssignments).where(eq(schema.hrClientAssignments.id, 'hrasg_a1'));
    expect(acme!.isPrimary).toBe(false);

    const overlap = await admin().send('POST', '/assignments', { employeeId: 'hremp_ann', companyId: 'co_acme', startDate: today() });
    expect(overlap.status).toBe(409);
    expect((await errorOf(overlap)).message).toBe('This employee is already assigned to this client for (part of) these dates');

    const gone = await admin().send('POST', '/assignments', { employeeId: 'hremp_ben', companyId: 'co_gone', startDate: daysFromToday(30) });
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).message).toBe('Gone Ltd was deleted in WeldCRM');

    expect((await admin().send('POST', '/assignments', { employeeId: 'hremp_nope', companyId: 'co_acme', startDate: today() })).status).toBe(404);
    expect((await admin().send('POST', '/assignments', { employeeId: 'hremp_ben', companyId: 'co_nope', startDate: today() })).status).toBe(404);
    const dates = await admin().send('POST', '/assignments', { employeeId: 'hremp_ben', companyId: 'co_acme', startDate: '2026-05-01', endDate: '2026-04-01' });
    expect(dates.status).toBe(400);
    expect((await errorOf(dates)).message).toBe('Assignment: end date is before start date');
    const invalid = await admin().send('POST', '/assignments', { employeeId: 'hremp_ben', companyId: 'co_acme', startDate: 'tomorrow', allocationPercent: 150 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Allocation percent must be at most 100. Start date: Expected YYYY-MM-DD');
    expect((await as('employees:read').send('POST', '/assignments', { employeeId: 'hremp_ben', companyId: 'co_acme', startDate: today() })).status).toBe(403);
  });

  it('updates an assignment and refuses moving it onto another', async () => {
    const res = await admin().send('PATCH', '/assignments/hrasg_a1', { allocationPercent: 80, notes: 'More hours' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrasg_a1', allocationPercent: 80, notes: 'More hours' });

    await db.insert(schema.hrClientAssignments).values({ id: 'hrasg_a4', employeeId: 'hremp_ann', companyId: 'co_beta', startDate: daysFromToday(10) });
    const overlap = await admin().send('PATCH', '/assignments/hrasg_a2', { endDate: null });
    expect(overlap.status).toBe(409);
    expect((await admin().send('PATCH', '/assignments/hrasg_nope', { notes: 'x' })).status).toBe(404);
    expect((await as('employees:read').send('PATCH', '/assignments/hrasg_a1', { notes: 'x' })).status).toBe(403);
  });

  it('deletes an assignment', async () => {
    expect((await as('employees:read').send('DELETE', '/assignments/hrasg_a1')).status).toBe(403);
    expect((await admin().send('DELETE', '/assignments/hrasg_a1')).status).toBe(204);
    expect(await db.select().from(schema.hrClientAssignments).where(eq(schema.hrClientAssignments.id, 'hrasg_a1'))).toHaveLength(0);
    expect((await admin().send('DELETE', '/assignments/hrasg_a1')).status).toBe(404);
  });
});

describe('/clients', () => {
  beforeEach(async () => {
    await seedCompany(db, 'co_acme', 'Acme');
    await seedCompany(db, 'co_beta', 'Beta');
    await seedCompany(db, 'co_gone', 'Gone Ltd', new Date('2026-01-02T00:00:00Z'));
    await seedEmployee(db, { id: 'hremp_ann', email: 'ann@example.com' });
    await seedEmployee(db, { id: 'hremp_ben', email: 'ben@example.com' });
    await db.insert(schema.hrClientAssignments).values([
      { id: 'hrasg_c1', employeeId: 'hremp_ann', companyId: 'co_acme', startDate: daysFromToday(-60), allocationPercent: 60 },
      { id: 'hrasg_c2', employeeId: 'hremp_ben', companyId: 'co_acme', startDate: daysFromToday(-60), endDate: daysFromToday(-1) },
      { id: 'hrasg_c3', employeeId: 'hremp_ben', companyId: 'co_beta', startDate: daysFromToday(-5), allocationPercent: 25 },
      { id: 'hrasg_c4', employeeId: 'hremp_ann', companyId: 'co_gone', startDate: daysFromToday(-5) },
    ]);
  });

  it('lists client accounts by name with headcount and FTE, without deleted companies', async () => {
    const res = await admin().get('/clients');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual([
      { companyId: 'co_acme', companyName: 'Acme', activeCount: 1, totalCount: 2, fte: 0.6 },
      { companyId: 'co_beta', companyName: 'Beta', activeCount: 1, totalCount: 1, fte: 0.25 },
    ]);
    expect((await as('leave:read').get('/clients')).status).toBe(403);
  });

  it('answers one client with everyone who works or worked on it', async () => {
    const res = await admin().get('/clients/co_acme');
    expect(res.status).toBe(200);
    const body = await data<{ company: unknown; assignments: Array<{ id: string }> }>(res);
    expect(body.company).toEqual({ id: 'co_acme', name: 'Acme' });
    expect(body.assignments.map((a) => a.id).sort()).toEqual(['hrasg_c1', 'hrasg_c2']);
  });

  it('is a 404 for an unknown company and says so for a deleted one', async () => {
    expect((await admin().get('/clients/co_nope')).status).toBe(404);
    const gone = await admin().get('/clients/co_gone');
    expect(gone.status).toBe(404);
    expect(await errorOf(gone)).toEqual({ code: 'NOT_FOUND', message: 'Gone Ltd was deleted in WeldCRM' });
    expect((await as('leave:read').get('/clients/co_acme')).status).toBe(403);
  });
});
