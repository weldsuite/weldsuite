import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { getRecordFields } from './record-fields';

describe('WeldMerge record fields', () => {
  it('catalogues the payload of an issue event', () => {
    const paths = getRecordFields('merge_issue', 'status_changed')?.map((field) => field.path);
    expect(paths).toEqual(['id', 'key', 'title', 'status', 'priority', 'teamId', 'assigneeUserId']);
  });

  it('catalogues a pull request', () => {
    expect(getRecordFields('merge_pull_request', 'merged')?.map((field) => field.path)).toEqual([
      'id',
      'number',
      'title',
      'state',
      'url',
      'authorLogin',
      'repositoryId',
    ]);
  });

  it('gives a shipped release its release id and a changed one its own id', () => {
    const shipped = getRecordFields('merge_release', 'shipped')?.map((field) => field.path);
    expect(shipped).toEqual(expect.arrayContaining(['releaseId', 'name', 'version', 'deskTicketIds']));
    expect(shipped).not.toContain('status');
    const updated = getRecordFields('merge_release', 'updated')?.map((field) => field.path);
    expect(updated).toContain('id');
    expect(updated).not.toContain('releaseId');
  });

  it('has a label in both languages for every field, and does not call an issue title a job title', () => {
    for (const entity of ['merge_issue', 'merge_pull_request', 'merge_release']) {
      for (const field of getRecordFields(entity, undefined) ?? []) {
        const key = field.labelKey ?? field.path;
        expect([entity, key, (en.weldconnect.recordFields as Record<string, string>)[key]]).not.toContain(undefined);
        expect([entity, key, (nl.weldconnect.recordFields as Record<string, string>)[key]]).not.toContain(undefined);
      }
    }
    const title = getRecordFields('merge_issue', undefined)?.find((field) => field.path === 'title');
    expect(title?.labelKey).toBe('merge.title');
    expect((en.weldconnect.recordFields as Record<string, string>)['merge.title']).toBe('Title');
  });
});
