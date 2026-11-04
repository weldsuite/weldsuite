import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';
import { makeBlueprint } from './test-fixtures';
import {
  buildInstantiateBody,
  createProjectFormSchema,
  defaultCopy,
  defaultRoles,
  defaultStartDate,
  endDateOf,
  parseDateInput,
  phaseSummaries,
  templateWeeks,
  weekOf,
} from './template';
import { controlLines, weekdayName } from './control';

describe('weeks', () => {
  it('rounds the length up at 5 working days a week', () => {
    expect(templateWeeks(0)).toBe(0);
    expect(templateWeeks(1)).toBe(1);
    expect(templateWeeks(5)).toBe(1);
    expect(templateWeeks(6)).toBe(2);
    expect(templateWeeks(100)).toBe(20);
  });

  it('puts an offset in its week', () => {
    expect(weekOf(0)).toBe(1);
    expect(weekOf(4)).toBe(1);
    expect(weekOf(5)).toBe(2);
    expect(weekOf(19)).toBe(4);
  });
});

describe('phaseSummaries', () => {
  it('gives each phase its weeks, its tasks and its gate criteria', () => {
    expect(phaseSummaries(makeBlueprint())).toEqual([
      { key: 'discovery', name: 'Discovery', fromWeek: 1, toWeek: 4, tasks: 2, criteria: 1 },
      { key: 'build', name: 'Build', fromWeek: 5, toWeek: 14, tasks: 1, criteria: 0 },
    ]);
  });

  it('leaves an undated phase without weeks or tasks', () => {
    const blueprint = makeBlueprint({ phases: [{ key: 'x', name: 'X', startOffset: null, endOffset: null, gateCriteria: [] }] });
    expect(phaseSummaries(blueprint)[0]).toMatchObject({ fromWeek: null, toWeek: null, tasks: 0 });
  });
});

describe('dates', () => {
  it('reads only real calendar dates', () => {
    expect(parseDateInput('2027-01-11')?.toISOString()).toBe('2027-01-11T00:00:00.000Z');
    expect(parseDateInput('2027-02-30')).toBeNull();
    expect(parseDateInput('11 Jan 2027')).toBeNull();
  });

  it('starts on the next working day', () => {
    // Friday 6 Nov 2026 -> Monday 9 Nov; Monday 9 Nov -> Tuesday 10 Nov.
    expect(defaultStartDate(new Date(2026, 10, 6))).toBe('2026-11-09');
    expect(defaultStartDate(new Date(2026, 10, 9))).toBe('2026-11-10');
  });

  it('counts the end in working days, as the server does', () => {
    // 100 working days after Monday 11 Jan 2027 is Monday 31 May 2027.
    expect(endDateOf('2027-01-11', makeBlueprint())?.toISOString().slice(0, 10)).toBe('2027-05-31');
    expect(endDateOf('nonsense', makeBlueprint())).toBeNull();
  });

  it('uses the working days of the template calendar', () => {
    const sevenDays = makeBlueprint({ durationDays: 7, settings: { schedule: { workingDays: [1, 2, 3, 4, 5, 6, 7], autoSchedule: false } } });
    expect(endDateOf('2027-01-11', sevenDays)?.toISOString().slice(0, 10)).toBe('2027-01-18');
  });
});

describe('the Create project form', () => {
  const values = {
    name: 'Supplier portal',
    client: { id: 'cmp_1', name: 'Van Dalen' },
    startDate: '2027-01-11',
    roles: { project_manager: 'u_sanne', sponsor: null },
    copy: { ...defaultCopy(), raid: false },
  };

  it('defaults the project manager to the signed-in person', () => {
    expect(defaultRoles(makeBlueprint(), 'u_sanne')).toEqual({ project_manager: 'u_sanne', sponsor: null });
  });

  it('builds the request the API accepts, leaving empty roles out', () => {
    expect(buildInstantiateBody(values)).toEqual({
      name: 'Supplier portal',
      startDate: '2027-01-11',
      clientId: 'cmp_1',
      roles: { project_manager: 'u_sanne' },
      copy: { ...defaultCopy(), raid: false },
    });
  });

  it('sends no client when none is picked', () => {
    expect(buildInstantiateBody({ ...values, client: null })?.clientId).toBeNull();
  });

  it('rejects a blank name and a bad date', () => {
    expect(createProjectFormSchema.safeParse({ ...values, name: '  ' }).success).toBe(false);
    expect(createProjectFormSchema.safeParse({ ...values, startDate: '2027-13-01' }).success).toBe(false);
    expect(createProjectFormSchema.safeParse(values).success).toBe(true);
  });
});

describe('controlLines', () => {
  const ctx = {
    copy: en.flowClosing.templates.preview.control,
    plural: (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, 'en'),
    format: interpolate,
    intlLocale: 'en-US',
  };

  it('writes out the control settings', () => {
    const lines = Object.fromEntries(controlLines(makeBlueprint(), ctx).map((line) => [line.key, line.value]));
    expect(lines.changeApproval).toBe('Project manager up to €5,000 and 5 working days, change board above');
    expect(lines.changeBoard).toBe('Sponsor, Project manager');
    expect(lines.statusReport).toBe('Every other week on Friday at 16:00 to the sponsor and all stakeholders');
    expect(lines.riskAppetite).toBe('Score 12 of 25');
  });

  it('says not set when a template has no settings', () => {
    const blueprint = makeBlueprint({ settings: {} });
    expect(controlLines(blueprint, ctx).every((line) => line.value === 'Not set')).toBe(true);
  });

  it('names the weekday in the user language', () => {
    expect(weekdayName(1, 'en-US')).toBe('Monday');
    expect(weekdayName(5, 'nl-NL')).toBe('vrijdag');
  });
});
