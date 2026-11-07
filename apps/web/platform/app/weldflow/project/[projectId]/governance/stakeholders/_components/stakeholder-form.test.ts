import { describe, expect, it } from 'vitest';
import type { Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';
import {
  buildCreateInput,
  buildUpdateInput,
  defaultStakeholderValues,
  stakeholderFormSchema,
  valuesFromStakeholder,
} from './stakeholder-form';

const messages = { required: 'Required', tooLong: (max: number) => `At most ${max}` };

const row: Stakeholder = {
  id: 'stk_1',
  projectId: 'prj_1',
  kind: 'contact',
  memberId: null,
  crmContactId: 'per_1',
  name: 'Grace Hopper',
  email: 'grace@example.com',
  organisation: 'Navy',
  role: 'Client lead',
  influence: 5,
  interest: 4,
  attitude: 'supportive',
  engagement: 'leading',
  notes: 'Prefers calls',
  lastContactAt: '2026-10-30T14:30:00.000Z',
  portalAccess: true,
  portalInvitedAt: null,
  createdBy: 'user_1',
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
};

describe('stakeholderFormSchema', () => {
  const create = stakeholderFormSchema(messages, 'create');
  const edit = stakeholderFormSchema(messages, 'edit');

  it('asks a new stakeholder for a team member', () => {
    const result = create.safeParse(defaultStakeholderValues());
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([['memberId', 'Required']]);
    expect(create.safeParse({ ...defaultStakeholderValues(), memberId: 'user_1' }).success).toBe(true);
  });

  it('asks for the id of a CRM contact when the person comes from the CRM', () => {
    const base = { ...defaultStakeholderValues(), kind: 'contact' as const };
    expect(create.safeParse({ ...base, contactId: '   ' }).error?.issues[0]?.path).toEqual(['contactId']);
    expect(create.safeParse({ ...base, contactId: 'per_1' }).success).toBe(true);
  });

  it('does not ask an edit for a person, it keeps the one it has', () => {
    expect(edit.safeParse(valuesFromStakeholder(row)).success).toBe(true);
  });

  it('stops text at the length the API takes', () => {
    const tooLong = { ...valuesFromStakeholder(row), role: 'x'.repeat(101) };
    expect(edit.safeParse(tooLong).error?.issues[0]?.message).toBe('At most 100');
  });

  it('refuses a score outside 1 to 5', () => {
    expect(edit.safeParse({ ...valuesFromStakeholder(row), influence: '6' }).success).toBe(false);
  });
});

describe('buildCreateInput', () => {
  it('adds a team member with the scores of the form', () => {
    const values = { ...defaultStakeholderValues(), memberId: 'user_1', role: ' Sponsor ', influence: '5' as const, interest: '2' as const, attitude: 'supportive' as const };
    expect(buildCreateInput('prj_1', values)).toEqual({
      projectId: 'prj_1',
      memberId: 'user_1',
      organisation: null,
      role: 'Sponsor',
      influence: 5,
      interest: 2,
      attitude: 'supportive',
      engagement: 'neutral',
      notes: null,
      lastContactAt: null,
    });
  });

  it('adds a CRM contact by the trimmed id and sends the last contact as a timestamp', () => {
    const values = { ...defaultStakeholderValues(), kind: 'contact' as const, contactId: ' per_1 ', lastContact: '2026-11-04' };
    const input = buildCreateInput('prj_1', values);
    expect(input).toMatchObject({ crmContactId: 'per_1', lastContactAt: '2026-11-04T00:00:00.000Z' });
    expect(input).not.toHaveProperty('memberId');
  });
});

describe('buildUpdateInput', () => {
  it('fills the form from the row and sends the numbers back', () => {
    const values = valuesFromStakeholder(row);
    expect(values).toMatchObject({ influence: '5', interest: '4', organisation: 'Navy', role: 'Client lead', lastContact: '2026-10-30', notes: 'Prefers calls' });
    expect(buildUpdateInput(row, values)).toEqual({
      organisation: 'Navy',
      role: 'Client lead',
      influence: 5,
      interest: 4,
      attitude: 'supportive',
      engagement: 'leading',
      notes: 'Prefers calls',
    });
  });

  it('leaves the last contact alone when its day was not changed, so the time of day stays', () => {
    expect(buildUpdateInput(row, valuesFromStakeholder(row))).not.toHaveProperty('lastContactAt');
  });

  it('sends a changed or cleared last contact', () => {
    expect(buildUpdateInput(row, { ...valuesFromStakeholder(row), lastContact: '2026-11-04' })).toMatchObject({ lastContactAt: '2026-11-04T00:00:00.000Z' });
    expect(buildUpdateInput(row, { ...valuesFromStakeholder(row), lastContact: '' })).toMatchObject({ lastContactAt: null });
  });

  it('clears an emptied organisation, role and notes', () => {
    const input = buildUpdateInput(row, { ...valuesFromStakeholder(row), organisation: ' ', role: '', notes: '' });
    expect(input).toMatchObject({ organisation: null, role: null, notes: null });
  });
});
