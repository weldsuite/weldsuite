/**
 * Lockstep checks for platformSyncMap — ensure first-slice task/mail topics
 * invalidate the canonical TanStack Query roots used by WeldFlow + WeldMail.
 */
import { describe, expect, it } from 'vitest';
import { platformSyncMap } from './sync-map';

describe('platformSyncMap — WeldFlow tasks + WeldMail', () => {
  it('project_task invalidates projects, my-tasks, and task-panel', () => {
    const keys = platformSyncMap.project_task?.invalidate ?? [];
    const serialized = keys.map((k) => JSON.stringify(k));
    expect(serialized).toContain(JSON.stringify(['projects']));
    expect(serialized).toContain(JSON.stringify(['task']));
    expect(serialized).toContain(JSON.stringify(['app-api', 'task-panel']));
  });

  it('email + mail folder/label topics invalidate mail caches', () => {
    expect(platformSyncMap.email?.invalidate).toEqual([['mail']]);
    expect(platformSyncMap.mail_folder?.invalidate).toEqual([['mail']]);
    expect(platformSyncMap.mail_label?.invalidate).toEqual([['mail', 'labels']]);
    expect(platformSyncMap.mail_draft?.invalidate).toEqual([['mail', 'drafts']]);
  });

  it('task topic keeps detail helpers for personal/my-tasks detail cache', () => {
    expect(platformSyncMap.task?.updateDetail).toBeTypeOf('function');
    expect(platformSyncMap.task?.remove).toBeTypeOf('function');
    expect(platformSyncMap.task?.invalidate).toEqual([['task']]);
  });
});
