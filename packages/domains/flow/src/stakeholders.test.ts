import { describe, expect, it } from 'vitest';
import {
  changedStakeholders,
  identityError,
  presentStakeholder,
  projectPortalUrl,
  raciAssignmentsError,
  raciSubjectError,
  sortAssignments,
  stakeholderEventData,
} from './stakeholders';

describe('identity', () => {
  it('needs exactly one of the member and the contact', () => {
    expect(identityError('user_1', null)).toBeNull();
    expect(identityError(null, 'per_1')).toBeNull();
    expect(identityError(undefined, undefined)).toBe('Provide either memberId or crmContactId');
    expect(identityError('', '')).toBe('Provide either memberId or crmContactId');
    expect(identityError('user_1', 'per_1')).toBe('Provide either memberId or crmContactId, not both');
  });
});

describe('RACI', () => {
  it('ties the subject id to deliverables only', () => {
    expect(raciSubjectError('deliverable', 'del_1')).toBeNull();
    expect(raciSubjectError('deliverable', null)).toBe('subjectId is required for a deliverable');
    expect(raciSubjectError('go_live', undefined)).toBeNull();
    expect(raciSubjectError('change_requests', 'del_1')).toBe('subjectId is only for a deliverable');
  });

  it('allows one accountable and each letter once per stakeholder', () => {
    expect(raciAssignmentsError([])).toBeNull();
    expect(
      raciAssignmentsError([
        { stakeholderId: 's1', letter: 'A' },
        { stakeholderId: 's1', letter: 'R' },
        { stakeholderId: 's2', letter: 'C' },
      ]),
    ).toBeNull();
    expect(
      raciAssignmentsError([
        { stakeholderId: 's1', letter: 'A' },
        { stakeholderId: 's2', letter: 'A' },
      ]),
    ).toBe('A subject can have only one accountable (A)');
    expect(
      raciAssignmentsError([
        { stakeholderId: 's1', letter: 'C' },
        { stakeholderId: 's1', letter: 'C' },
      ]),
    ).toBe('A stakeholder can have a letter only once per subject');
  });

  it('orders assignments by stakeholder, then A R C I', () => {
    expect(
      sortAssignments(
        [
          { stakeholderId: 's2', letter: 'I' },
          { stakeholderId: 's1', letter: 'R' },
          { stakeholderId: 's1', letter: 'A' },
          { stakeholderId: 'gone', letter: 'C' },
        ],
        ['s1', 's2'],
      ),
    ).toEqual([
      { stakeholderId: 's1', letter: 'A' },
      { stakeholderId: 's1', letter: 'R' },
      { stakeholderId: 's2', letter: 'I' },
      { stakeholderId: 'gone', letter: 'C' },
    ]);
  });

  it('names the stakeholders whose letters changed', () => {
    const before = [
      { stakeholderId: 's1', letter: 'A' as const },
      { stakeholderId: 's2', letter: 'C' as const },
    ];
    const after = [
      { stakeholderId: 's1', letter: 'A' as const },
      { stakeholderId: 's2', letter: 'I' as const },
      { stakeholderId: 's3', letter: 'R' as const },
    ];
    expect(changedStakeholders(before, after)).toEqual(['s2', 's3']);
    expect(changedStakeholders(before, [])).toEqual(['s1', 's2']);
    expect(changedStakeholders(before, before)).toEqual([]);
  });
});

describe('portal address', () => {
  it('joins the base, the workspace and the project', () => {
    expect(projectPortalUrl('https://projects.weldsuite.org', 'acme', 'prj_1')).toBe('https://projects.weldsuite.org/acme/projects/prj_1');
    expect(projectPortalUrl('https://projects-test.weldsuite.org/', 'acme', 'prj 1')).toBe('https://projects-test.weldsuite.org/acme/projects/prj%201');
    expect(projectPortalUrl('https://projects.weldsuite.org///', 'acme', 'prj_1')).toBe('https://projects.weldsuite.org/acme/projects/prj_1');
    expect(projectPortalUrl('/', 'acme', 'prj_1')).toBe('/acme/projects/prj_1');
  });
});

describe('presenting', () => {
  const now = new Date('2026-11-03T10:00:00.000Z');
  const row = {
    id: 'stk_1',
    projectId: 'prj_1',
    memberId: null,
    crmContactId: 'per_1',
    organisation: 'Van Dijk Groothandel',
    role: 'IT manager',
    influence: 4,
    interest: 5,
    attitude: 'supportive' as const,
    engagement: 'leading' as const,
    notes: null,
    lastContactAt: now,
    portalAccess: true,
    portalInvitedAt: null,
    createdBy: 'user_1',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  it('shows who the stakeholder is, with ISO timestamps', () => {
    const shown = presentStakeholder(row, { name: 'Femke de Graaf', email: 'femke@example.com' });
    expect(shown).toMatchObject({
      kind: 'contact',
      memberId: null,
      crmContactId: 'per_1',
      name: 'Femke de Graaf',
      email: 'femke@example.com',
      lastContactAt: '2026-11-03T10:00:00.000Z',
      portalInvitedAt: null,
      portalAccess: true,
    });
    expect(presentStakeholder({ ...row, memberId: 'user_9', crmContactId: null }, { name: null, email: null }).kind).toBe('member');
  });

  it('keeps names and emails out of the event', () => {
    const data = stakeholderEventData(row);
    expect(data).not.toHaveProperty('name');
    expect(data).not.toHaveProperty('email');
    expect(data).toMatchObject({ id: 'stk_1', kind: 'contact', influence: 4, portalAccess: true });
  });
});
