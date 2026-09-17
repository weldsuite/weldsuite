/**
 * Lockstep checks for platformSyncMap — ensure first-slice task/mail topics
 * invalidate the canonical TanStack Query roots used by WeldFlow + WeldMail,
 * and that Phase 0 catalog-driven member ACL covers every non-personal map key.
 */
import { describe, expect, it } from 'vitest';
import { listMemberHubTopics } from '@weldsuite/entity-events';
import { isBarePersonalTopic } from '@weldsuite/realtime';
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

describe('platformSyncMap — Phase 0 member ACL lockstep', () => {
  it('every non-personal sync-map key is in the catalog-driven hub allow-list', () => {
    const allowed = new Set(listMemberHubTopics());
    const missing: string[] = [];
    for (const topic of Object.keys(platformSyncMap)) {
      // Bare personal topics are skipped client-side (`isBarePersonalTopic`);
      // notifications ride `notification.<userId>`, not the entity hub topic.
      if (isBarePersonalTopic(topic)) continue;
      if (!allowed.has(topic)) missing.push(topic);
    }
    expect(missing).toEqual([]);
  });
});
