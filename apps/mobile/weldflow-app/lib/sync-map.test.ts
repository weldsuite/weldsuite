/**
 * Lockstep checks for weldflowSyncMap (Phase 8).
 * Run via: pnpm --filter platform exec vitest run ../../mobile/weldflow-app/lib/sync-map.test.ts
 */
import { describe, expect, it } from 'vitest';
import { weldflowSyncMap } from './sync-map';

describe('weldflowSyncMap', () => {
  it('project invalidates projects + project detail roots', () => {
    expect(weldflowSyncMap.project?.invalidate).toEqual([
      ['weldflow', 'projects'],
      ['weldflow', 'project'],
    ]);
  });

  it('project_task invalidates lists + my-tasks + task detail', () => {
    expect(weldflowSyncMap.project_task?.invalidate).toEqual([
      ['weldflow', 'projects'],
      ['weldflow', 'project-tasks'],
      ['weldflow', 'task'],
      ['weldflow', 'my-tasks'],
    ]);
  });

  it('project_label invalidates labels root', () => {
    expect(weldflowSyncMap.project_label?.invalidate).toEqual([
      ['weldflow', 'labels'],
    ]);
  });

  it('covers primary shell topics', () => {
    for (const topic of [
      'project',
      'project_task',
      'project_member',
      'project_label',
      'task',
      'personal_task',
    ] as const) {
      expect(weldflowSyncMap[topic]?.invalidate?.length).toBeGreaterThan(0);
    }
  });
});
