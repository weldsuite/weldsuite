import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { recipientsLabel, scheduleSubject, scheduleWhen } from './schedule-labels';

const timing = { dayOfWeek: null, dayOfMonth: null, hour: 8, timezone: 'Europe/Amsterdam' } as const;

describe('scheduleWhen', () => {
  it('reads as a sentence for every frequency in English', () => {
    const t = en.helpdesk.reportSchedules;
    expect(scheduleWhen({ ...timing, frequency: 'daily' }, t)).toBe('Every day at 08:00 (Europe/Amsterdam)');
    expect(scheduleWhen({ ...timing, frequency: 'weekly', dayOfWeek: 1 }, t)).toBe('Every Monday at 08:00 (Europe/Amsterdam)');
    expect(scheduleWhen({ ...timing, frequency: 'weekly', dayOfWeek: 0, hour: 17 }, t)).toBe(
      'Every Sunday at 17:00 (Europe/Amsterdam)',
    );
    expect(scheduleWhen({ ...timing, frequency: 'monthly', dayOfMonth: 15, hour: 9 }, t)).toBe(
      'On day 15 of every month at 09:00 (Europe/Amsterdam)',
    );
  });

  it('reads as a sentence for every frequency in Dutch', () => {
    const t = nl.helpdesk.reportSchedules;
    expect(scheduleWhen({ ...timing, frequency: 'daily' }, t)).toBe('Elke dag om 08:00 (Europe/Amsterdam)');
    expect(scheduleWhen({ ...timing, frequency: 'weekly', dayOfWeek: 1 }, t)).toBe('Elke maandag om 08:00 (Europe/Amsterdam)');
    expect(scheduleWhen({ ...timing, frequency: 'weekly', dayOfWeek: 6 }, t)).toBe('Elke zaterdag om 08:00 (Europe/Amsterdam)');
    expect(scheduleWhen({ ...timing, frequency: 'monthly', dayOfMonth: 1 }, t)).toBe(
      'Op dag 1 van elke maand om 08:00 (Europe/Amsterdam)',
    );
  });
});

describe('scheduleSubject', () => {
  const t = en.helpdesk.reportSchedules;

  it('names the overview with its period', () => {
    expect(scheduleSubject({ reportId: null, reportTitle: null, range: 'last_30_days' }, t)).toEqual({
      label: 'Overview, Last 30 days',
      deleted: false,
    });
  });

  it('names a saved report by its title', () => {
    expect(scheduleSubject({ reportId: 'rpt_1', reportTitle: 'Weekly', range: 'last_7_days' }, t)).toEqual({
      label: 'Weekly',
      deleted: false,
    });
  });

  it('says so when the saved report was deleted', () => {
    expect(scheduleSubject({ reportId: 'rpt_1', reportTitle: null, range: 'last_7_days' }, t)).toEqual({
      label: 'Report was deleted',
      deleted: true,
    });
  });
});

describe('recipientsLabel', () => {
  it('counts recipients', () => {
    expect(recipientsLabel(1, en.helpdesk.reportSchedules)).toBe('1 recipient');
    expect(recipientsLabel(3, en.helpdesk.reportSchedules)).toBe('3 recipients');
    expect(recipientsLabel(3, nl.helpdesk.reportSchedules)).toBe('3 ontvangers');
  });
});
