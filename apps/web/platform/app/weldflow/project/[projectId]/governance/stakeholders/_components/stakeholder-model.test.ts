import { describe, expect, it } from 'vitest';
import type { ActiveFilter } from '@weldsuite/ui/components/list-toolbar';
import type { RaciSubject, Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';
import {
  STAKEHOLDER_FILTER_FIELDS,
  applyStakeholderFilters,
  assignmentsAfter,
  formatContactDate,
  quadrantOf,
  raciSubjectTitle,
  scoreText,
  sideOf,
  stakeholderName,
} from './stakeholder-model';

function stakeholder(overrides: Partial<Stakeholder> = {}): Stakeholder {
  return {
    id: 'stk_1',
    projectId: 'prj_1',
    kind: 'member',
    memberId: 'user_1',
    crmContactId: null,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    organisation: 'Analytical Engines',
    role: 'Sponsor',
    influence: 3,
    interest: 3,
    attitude: 'neutral',
    engagement: 'neutral',
    notes: null,
    lastContactAt: null,
    portalAccess: false,
    portalInvitedAt: null,
    createdBy: 'user_1',
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

function filter(field: string, value: string, operator = 'is'): ActiveFilter {
  return { id: `${field}-${value}`, field, operator, value };
}

const ada = stakeholder();
const grace = stakeholder({ id: 'stk_2', kind: 'contact', memberId: null, crmContactId: 'per_1', name: 'Grace Hopper', email: null, organisation: 'Navy', role: 'Client lead', attitude: 'supportive', engagement: 'leading' });
const linus = stakeholder({ id: 'stk_3', name: 'Linus Torvalds', organisation: null, role: null, attitude: 'resistant', engagement: 'unaware' });
const rows = [ada, grace, linus];

describe('applyStakeholderFilters', () => {
  it('keeps everything without a search or filters', () => {
    expect(applyStakeholderFilters(rows, '', [])).toEqual(rows);
  });

  it('searches name, role and organisation, ignoring case and surrounding spaces', () => {
    expect(applyStakeholderFilters(rows, '  hopper ', [])).toEqual([grace]);
    expect(applyStakeholderFilters(rows, 'SPONSOR', [])).toEqual([ada]);
    expect(applyStakeholderFilters(rows, 'navy', [])).toEqual([grace]);
    expect(applyStakeholderFilters(rows, 'nobody', [])).toEqual([]);
  });

  it('filters by attitude and engagement, with is and is not', () => {
    expect(applyStakeholderFilters(rows, '', [filter(STAKEHOLDER_FILTER_FIELDS.attitude, 'supportive')])).toEqual([grace]);
    expect(applyStakeholderFilters(rows, '', [filter(STAKEHOLDER_FILTER_FIELDS.attitude, 'supportive', 'is not')])).toEqual([ada, linus]);
    expect(applyStakeholderFilters(rows, '', [filter(STAKEHOLDER_FILTER_FIELDS.engagement, 'unaware')])).toEqual([linus]);
  });

  it('filters by side: members are internal, CRM contacts are client', () => {
    expect(applyStakeholderFilters(rows, '', [filter(STAKEHOLDER_FILTER_FIELDS.type, 'client')])).toEqual([grace]);
    expect(applyStakeholderFilters(rows, '', [filter(STAKEHOLDER_FILTER_FIELDS.type, 'internal')])).toEqual([ada, linus]);
  });

  it('narrows by every filter in turn and by the search with them', () => {
    const filters = [filter(STAKEHOLDER_FILTER_FIELDS.type, 'internal'), filter(STAKEHOLDER_FILTER_FIELDS.attitude, 'resistant')];
    expect(applyStakeholderFilters(rows, '', filters)).toEqual([linus]);
    expect(applyStakeholderFilters(rows, 'ada', filters)).toEqual([]);
  });

  it('ignores a filter that is still being built', () => {
    expect(applyStakeholderFilters(rows, '', [filter(STAKEHOLDER_FILTER_FIELDS.attitude, '')])).toEqual(rows);
    expect(applyStakeholderFilters(rows, '', [filter(STAKEHOLDER_FILTER_FIELDS.attitude, 'resistant', '')])).toEqual(rows);
  });

  it('ignores a filter on a field it does not know', () => {
    expect(applyStakeholderFilters(rows, '', [filter('colour', 'red')])).toEqual(rows);
  });
});

describe('quadrantOf', () => {
  it('puts high influence on the top row and high interest on the right', () => {
    expect(quadrantOf({ influence: 5, interest: 5 })).toBe('manageClosely');
    expect(quadrantOf({ influence: 4, interest: 1 })).toBe('keepSatisfied');
    expect(quadrantOf({ influence: 2, interest: 4 })).toBe('keepInformed');
    expect(quadrantOf({ influence: 3, interest: 3 })).toBe('monitor');
  });

  it('counts 4 as high and 3 as low', () => {
    expect(quadrantOf({ influence: 4, interest: 4 })).toBe('manageClosely');
    expect(quadrantOf({ influence: 3, interest: 4 })).toBe('keepInformed');
  });
});

describe('small helpers', () => {
  it('names a person by name, else email, else nothing', () => {
    expect(stakeholderName({ name: 'Ada', email: 'ada@example.com' })).toBe('Ada');
    expect(stakeholderName({ name: null, email: 'ada@example.com' })).toBe('ada@example.com');
    expect(stakeholderName({ name: null, email: null })).toBe('');
  });

  it('writes the scores as influence / interest', () => {
    expect(scoreText({ influence: 4, interest: 2 })).toBe('4 / 2');
  });

  it('writes a last contact as its day in UTC, however far behind UTC the zone is', () => {
    expect(formatContactDate('2026-11-04T00:00:00.000Z', 'en-US')).toBe('Nov 4, 2026');
    expect(formatContactDate('2026-11-04T00:00:00.000Z', 'nl-NL')).toBe('4 nov 2026');
    expect(formatContactDate(null, 'en-US')).toBe('');
  });

  it('puts members on the internal side and contacts on the client side', () => {
    expect(sideOf({ kind: 'member' })).toBe('internal');
    expect(sideOf({ kind: 'contact' })).toBe('client');
  });
});

describe('assignmentsAfter', () => {
  const subject: RaciSubject = {
    subjectType: 'deliverable',
    subjectId: 'dlv_1',
    code: 'D1',
    title: 'Design',
    assignments: [
      { stakeholderId: 'stk_1', letter: 'A' },
      { stakeholderId: 'stk_2', letter: 'R' },
    ],
  };

  it('sets the letter of one person and leaves the others', () => {
    expect(assignmentsAfter(subject, 'stk_3', 'C')).toEqual([
      { stakeholderId: 'stk_1', letter: 'A' },
      { stakeholderId: 'stk_2', letter: 'R' },
      { stakeholderId: 'stk_3', letter: 'C' },
    ]);
  });

  it('replaces the letter a person already had', () => {
    expect(assignmentsAfter(subject, 'stk_2', 'I')).toEqual([
      { stakeholderId: 'stk_1', letter: 'A' },
      { stakeholderId: 'stk_2', letter: 'I' },
    ]);
  });

  it('drops the person for an empty letter', () => {
    expect(assignmentsAfter(subject, 'stk_1', '')).toEqual([{ stakeholderId: 'stk_2', letter: 'R' }]);
  });

  it('moves the accountable letter to the new person, as a row has only one', () => {
    expect(assignmentsAfter(subject, 'stk_2', 'A')).toEqual([{ stakeholderId: 'stk_2', letter: 'A' }]);
  });

  it('keeps an accountable person who stays accountable', () => {
    expect(assignmentsAfter(subject, 'stk_1', 'A')).toEqual([
      { stakeholderId: 'stk_2', letter: 'R' },
      { stakeholderId: 'stk_1', letter: 'A' },
    ]);
  });
});

describe('raciSubjectTitle', () => {
  const names = { changeRequests: 'Change requests', goLive: 'Go-live decision' };

  it('names a deliverable by its code and title', () => {
    expect(raciSubjectTitle({ subjectType: 'deliverable', subjectId: 'dlv_1', code: 'D2', title: 'Build', assignments: [] }, names)).toBe('D2 Build');
  });

  it('names the two standing rows', () => {
    expect(raciSubjectTitle({ subjectType: 'change_requests', subjectId: null, code: null, title: null, assignments: [] }, names)).toBe('Change requests');
    expect(raciSubjectTitle({ subjectType: 'go_live', subjectId: null, code: null, title: null, assignments: [] }, names)).toBe('Go-live decision');
  });
});
