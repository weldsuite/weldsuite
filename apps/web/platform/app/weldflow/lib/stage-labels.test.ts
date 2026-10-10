import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { localizeStageName } from './stage-labels';

describe('localizeStageName', () => {
  it('translates the default stage names', () => {
    expect(localizeStageName('To Do', 'todo', nl.projects.tasks)).toBe(nl.projects.tasks.statusTodo);
    expect(localizeStageName('In Progress', 'in_progress', nl.projects.tasks)).toBe(nl.projects.tasks.statusInProgress);
    expect(localizeStageName('In Review', 'review', nl.projects.tasks)).toBe(nl.projects.tasks.statusInReview);
    expect(localizeStageName('Done', 'done', nl.projects.tasks)).toBe(nl.projects.tasks.statusDone);
  });

  it('matches the default name case-insensitively and ignores surrounding space', () => {
    expect(localizeStageName(' to do ', 'todo', nl.projects.tasks)).toBe(nl.projects.tasks.statusTodo);
  });

  it('keeps user-configured stage names as typed', () => {
    expect(localizeStageName('Blocked', 'todo', nl.projects.tasks)).toBe('Blocked');
    expect(localizeStageName('QA', 'in_progress', nl.projects.tasks)).toBe('QA');
  });

  it('keeps a default-looking name on a different system status', () => {
    expect(localizeStageName('Done', 'todo', nl.projects.tasks)).toBe('Done');
  });

  it('returns the English label for English', () => {
    expect(localizeStageName('To Do', 'todo', en.projects.tasks)).toBe(en.projects.tasks.statusTodo);
  });

  it('falls back to the stored name without a system status', () => {
    expect(localizeStageName('To Do', null, nl.projects.tasks)).toBe('To Do');
  });
});
