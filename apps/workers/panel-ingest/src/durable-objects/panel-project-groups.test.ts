import type { PanelGroupOp } from '@weldsuite/panel-domain/project-object';
import type { PanelGroupRecord } from '@weldsuite/panel-domain/tables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { resetWarnings } from '../lib/warn';
import { NOW, PROJECT_ID, WORKSPACE_ID, fakePipeline, fakeSqlContext } from '../testing/fakes';
import { PanelProject } from './panel-project';

const SCOPE = { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID };
const ISO = new Date(NOW).toISOString();

function create(bound = true) {
  const groups = fakePipeline<PanelGroupRecord>();
  const people = fakePipeline<Record<string, unknown>>();
  const env = (bound ? { PANEL_GROUPS_STREAM: groups, PANEL_PEOPLE: people } : {}) as unknown as Env;
  return { project: new PanelProject(fakeSqlContext().ctx, env), groups, people };
}

const set = (groupType: string, groupKey: string, props: Record<string, string | number | null> = {}): PanelGroupOp => ({ op: 'set', groupType, groupKey, props });

describe('PanelProject groups', () => {
  beforeEach(() => {
    resetWarnings();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('creates, updates and snapshots a group profile, one row per group and call (each change takes a version)', async () => {
    const { project, groups } = create();
    const result = await project.applyGroupOps({
      ...SCOPE,
      ops: [set('company', 'acme', { $name: 'Acme' }), { op: 'set_once', groupType: 'company', groupKey: 'acme', props: { $name: 'Other', plan: 'pro' } }],
    });

    expect(result).toEqual({ applied: 2, dropped: 0, types: ['company'] });
    expect(groups.sent).toEqual([
      { workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, group_type: 'company', group_key: 'acme', version: 2, ts: ISO, properties: '{"$name":"Acme","plan":"pro"}', deleted: false },
    ]);
    expect(await project.getGroup('company', 'acme')).toEqual({
      groupType: 'company',
      groupKey: 'acme',
      properties: { $name: 'Acme', plan: 'pro' },
      firstSeen: ISO,
      lastSeen: ISO,
    });

    await project.applyGroupOps({ ...SCOPE, ops: [{ op: 'unset', groupType: 'company', groupKey: 'acme', keys: ['plan'] }] });
    expect(groups.sent.at(-1)).toMatchObject({ version: 3, properties: '{"$name":"Acme"}' });

    // No change: last seen only, no row.
    await project.applyGroupOps({ ...SCOPE, ops: [set('company', 'acme', { $name: 'Acme' })] });
    expect(groups.sent).toHaveLength(2);
  });

  it('takes at most five group types, in order, and drops the operations of a sixth', async () => {
    const { project } = create();
    await project.applyGroupOps({ ...SCOPE, ops: ['a', 'b', 'c'].map((t) => set(t, 'k')) });
    expect(await project.ensureGroupTypes(['d', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e']);

    const result = await project.applyGroupOps({ ...SCOPE, ops: [set('f', 'k'), set('a', 'k2')] });
    expect(result).toEqual({ applied: 1, dropped: 1, types: ['a', 'b', 'c', 'd', 'e'] });
    expect(await project.getGroup('f', 'k')).toBeNull();

    await project.releaseGroupType('b');
    expect(await project.ensureGroupTypes(['f', 'Bad'])).toEqual(['a', 'c', 'd', 'e', 'f']);
    expect(await project.groupTypes()).toEqual(['a', 'c', 'd', 'e', 'f']);
    // The released type's profile stays.
    expect(await project.getGroup('b', 'k')).not.toBeNull();
  });

  it('lists one type, most recently seen first, with search on the key and the name, and a cursor', async () => {
    const { project } = create();
    for (const [i, key] of ['alpha', 'beta', 'gamma'].entries()) {
      vi.setSystemTime(NOW + i * 1000);
      await project.applyGroupOps({ ...SCOPE, ops: [set('company', key, { $name: `${key.toUpperCase()} Inc` })] });
    }
    await project.applyGroupOps({ ...SCOPE, ops: [set('workspace', 'alpha')] });

    const first = await project.listGroups({ groupType: 'company', limit: 2 });
    expect(first.groups.map((g) => g.groupKey)).toEqual(['gamma', 'beta']);
    expect(first.totalCount).toBe(3);
    const second = await project.listGroups({ groupType: 'company', limit: 2, cursor: first.cursor });
    expect(second.groups.map((g) => g.groupKey)).toEqual(['alpha']);
    expect(second.cursor).toBeNull();

    expect((await project.listGroups({ groupType: 'company', search: 'BETA inc', limit: 10 })).groups.map((g) => g.groupKey)).toEqual(['beta']);
    expect((await project.listGroups({ groupType: 'company', search: 'amm', limit: 10 })).groups.map((g) => g.groupKey)).toEqual(['gamma']);
    expect((await project.listGroups({ groupType: 'company', search: '100%', limit: 10 })).totalCount).toBe(0);
  });

  it('deletes a group and writes a deleted row', async () => {
    const { project, groups } = create();
    await project.applyGroupOps({ ...SCOPE, ops: [set('company', 'acme', { plan: 'pro' })] });

    expect(await project.deleteGroup({ ...SCOPE, groupType: 'company', groupKey: 'acme' })).toBe(true);
    expect(groups.sent.at(-1)).toMatchObject({ group_key: 'acme', deleted: true, properties: '{}', version: 2 });
    expect(await project.getGroup('company', 'acme')).toBeNull();
    expect(await project.deleteGroup({ ...SCOPE, groupType: 'company', groupKey: 'acme' })).toBe(false);
  });

  it('shares the change counter with people, so versions never repeat', async () => {
    const { project, groups, people } = create();
    await project.applyPeopleOps({ ...SCOPE, ops: [{ op: 'set', userId: 'u-1', ts: ISO, props: { plan: 'pro' } }] });
    await project.applyGroupOps({ ...SCOPE, ops: [set('company', 'acme')] });
    expect(people.sent[0]).toMatchObject({ version: 1 });
    expect(groups.sent[0]).toMatchObject({ version: 2 });
  });

  it('keeps the profile when the stream is not bound', async () => {
    const { project } = create(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await project.applyGroupOps({ ...SCOPE, ops: [set('company', 'acme')] });
    expect(await project.getGroup('company', 'acme')).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('groups_v1'));
  });
});
