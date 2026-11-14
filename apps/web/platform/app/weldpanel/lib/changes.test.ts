import { describe, expect, it } from 'vitest';
import { makeProject } from '../test-fixtures';
import { privacyFormValues, projectChanges, projectFormValues, settingsChanges } from './changes';

describe('projectChanges', () => {
  const project = makeProject({ name: 'Site', kind: 'website', allowedDomains: ['a.com', 'b.com'] });

  it('is empty when nothing changed', () => {
    expect(projectChanges(projectFormValues(project), project)).toEqual({});
  });

  it('names only the fields that changed', () => {
    expect(projectChanges({ ...projectFormValues(project), name: 'New' }, project)).toEqual({ name: 'New' });
    expect(projectChanges({ ...projectFormValues(project), kind: 'app' }, project)).toEqual({ kind: 'app' });
    expect(projectChanges({ ...projectFormValues(project), allowedDomains: ['a.com'] }, project)).toEqual({ allowedDomains: ['a.com'] });
  });

  it('treats a reordered list as a change', () => {
    expect(projectChanges({ ...projectFormValues(project), allowedDomains: ['b.com', 'a.com'] }, project)).toEqual({
      allowedDomains: ['b.com', 'a.com'],
    });
  });
});

describe('settingsChanges', () => {
  const { settings } = makeProject();

  it('is empty when nothing changed', () => {
    expect(settingsChanges(privacyFormValues(settings), settings)).toEqual({});
  });

  it('sends the sample rate as a share, and only when the percent changed', () => {
    const values = { ...privacyFormValues(settings), recordingSamplePercent: 25 };
    expect(settingsChanges(values, settings)).toEqual({ settings: { recordingSampleRate: 0.25 } });
    const odd = { ...settings, recordingSampleRate: 0.333 };
    expect(settingsChanges(privacyFormValues(odd), odd)).toEqual({});
  });

  it('sends changed IP filters and the AI switch', () => {
    const values = { ...privacyFormValues(settings), ipFilters: ['203.0.113.0/24'], aiEnabled: !settings.aiEnabled };
    expect(settingsChanges(values, settings)).toEqual({ settings: { ipFilters: ['203.0.113.0/24'], aiEnabled: !settings.aiEnabled } });
  });

  it('wraps the changed settings only', () => {
    const values = { ...privacyFormValues(settings), autocapture: false, maskingLevel: 'strict' as const };
    expect(settingsChanges(values, settings)).toEqual({ settings: { autocapture: false, maskingLevel: 'strict' } });
  });

  it('sends the whole pattern list when it changed', () => {
    const values = { ...privacyFormValues(settings), excludedUrls: ['/admin/*', '/internal/*'] };
    expect(settingsChanges(values, settings)).toEqual({ settings: { excludedUrls: ['/admin/*', '/internal/*'] } });
  });
});
