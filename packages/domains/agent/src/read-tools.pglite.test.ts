/**
 * The read tools against a real tenant schema (pglite): tasks, projects and
 * people, with and without the row-level scope the default WeldAgent applies.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { like } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { PLATFORM_TOOLS, type ToolContext } from './tools';

const tool = (id: string) => PLATFORM_TOOLS.find((t) => t.id === id)!;

let db: Database;

const day = 24 * 60 * 60 * 1000;
const at = (offsetDays: number, hour = 12) => {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return new Date(d.getTime() + offsetDays * day);
};
const todayDate = () => new Date().toISOString().slice(0, 10);

const ME = 'user_me';
const BOB = 'user_bob';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    agentId: 'agt_test',
    actorUserId: ME,
    workspaceId: 'org_1',
    userTimezone: 'UTC',
    ...overrides,
  };
}

const scoped = (allPeople = false, allProjects = false): Partial<ToolContext> => ({
  rowScope: { userId: ME, allPeople, allProjects },
});

async function task(overrides: Partial<typeof schema.tasks.$inferInsert> & { id: string; title: string }) {
  await db.insert(schema.tasks).values({ status: 'todo', priority: 'medium', position: 0, ...overrides });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();

  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_me', userId: ME, email: 'ann@example.com', name: 'Ann Me', role: 'MEMBER' },
    { id: 'wm_bob', userId: BOB, email: 'bob@example.com', name: 'Bob Other', role: 'MEMBER' },
  ]);
  await db.insert(schema.projects).values([
    { id: 'prj_e2e', name: 'E2E Project', status: 'Active', key: 'E2E', createdAt: now, updatedAt: now, projectManagerId: BOB },
    { id: 'prj_secret', name: 'Secret Project', status: 'Planning', key: 'SEC', createdAt: now, updatedAt: now },
    { id: 'prj_gone', name: 'Deleted Project', status: 'Active', createdAt: now, updatedAt: now, deletedAt: now },
  ]);
  await db.insert(schema.projectMembers).values({ id: 'pm_1', projectId: 'prj_e2e', userId: ME, role: 'member' });

  await task({ id: 'task_overdue', title: 'Overdue report', projectId: 'prj_e2e', assigneeId: ME, dueDate: at(-1), number: 1 });
  await task({ id: 'task_today', title: 'Due today', projectId: 'prj_e2e', assigneeId: ME, dueDate: at(0, 20), status: 'in_progress', number: 2 });
  await task({ id: 'task_later', title: 'Due next week', projectId: 'prj_e2e', assigneeIds: [ME, BOB], dueDate: at(7), number: 3 });
  await task({ id: 'task_done', title: 'Finished work', projectId: 'prj_e2e', assigneeId: ME, dueDate: at(-2), status: 'done', number: 4 });
  await task({ id: 'task_nodue', title: 'No due date', projectId: 'prj_e2e', assigneeId: BOB, number: 5 });
  await task({ id: 'task_secret_bob', title: 'Secret plan', projectId: 'prj_secret', assigneeId: BOB, dueDate: at(0), number: 6 });
  await task({ id: 'task_secret_me', title: 'Assigned into secret', projectId: 'prj_secret', assigneeId: ME, dueDate: at(0), number: 7 });
  await task({ id: 'task_personal_me', title: 'My own errand', assigneeId: ME, dueDate: at(0), number: 8 });
  await task({ id: 'task_personal_bob', title: 'Bob errand', assigneeId: BOB, reporterId: BOB, dueDate: at(0), number: 9 });
  await task({ id: 'task_in_gone', title: 'Ghost task', projectId: 'prj_gone', assigneeId: ME, dueDate: at(0), number: 10 });
}, 120_000);

describe('tasks.list', () => {
  it('"what is on my plate today": mine, not finished, overdue or due today, soonest first', async () => {
    const result = (await tool('tasks.list').execute(
      ctx(),
      { assignedToMe: true, includeDone: false, dueOnOrBefore: todayDate() },
    )) as { totalCount: number; tasks: Array<{ title: string }> };

    const titles = result.tasks.map((t) => t.title);
    // Mine, overdue or due today, soonest first: yesterday's task leads.
    expect([...titles].sort()).toEqual(['Assigned into secret', 'Due today', 'My own errand', 'Overdue report']);
    expect(titles[0]).toBe('Overdue report');
    // Not finished, not due later, not someone else's, not in a deleted project.
    for (const left of ['Finished work', 'Due next week', 'Secret plan', 'Ghost task', 'No due date']) {
      expect(titles).not.toContain(left);
    }
    expect(result.totalCount).toBe(result.tasks.length);
  });

  it('counts a date as the whole day, so a task due this evening is still due today', async () => {
    const result = (await tool('tasks.list').execute(ctx(), {
      assignedToMe: true,
      dueOnOrBefore: todayDate(),
      search: 'Due today',
    })) as { tasks: Array<{ title: string }> };
    expect(result.tasks.map((t) => t.title)).toEqual(['Due today']);
  });

  it('finds multi-assignee tasks and returns names, project and due date (no raw member ids needed)', async () => {
    const result = (await tool('tasks.list').execute(ctx(), { assignedToMe: true, search: 'next week' })) as {
      tasks: Array<{ title: string; assignees: string[]; assigneeIds: string[]; projectName: string | null; dueDate: string | null; number: number | null }>;
    };
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: 'Due next week',
      assignees: ['Ann Me', 'Bob Other'],
      assigneeIds: [ME, BOB],
      projectName: 'E2E Project',
      number: 3,
    });
    expect(result.tasks[0].dueDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps every status when includeDone is not given', async () => {
    const result = (await tool('tasks.list').execute(ctx(), { assignedToMe: true, projectId: 'prj_e2e' })) as {
      tasks: Array<{ title: string }>;
    };
    expect(result.tasks.map((t) => t.title)).toContain('Finished work');
    const open = (await tool('tasks.list').execute(ctx(), {
      assignedToMe: true,
      projectId: 'prj_e2e',
      includeDone: false,
    })) as { tasks: Array<{ title: string }> };
    expect(open.tasks.map((t) => t.title)).not.toContain('Finished work');
  });

  it('refuses a due date it cannot read', async () => {
    await expect(tool('tasks.list').execute(ctx(), { dueOnOrBefore: 'next friday' })).resolves.toMatchObject({
      error: expect.stringContaining('ISO date'),
    });
    await expect(tool('tasks.list').execute(ctx(), { dueOnOrBefore: '2026-02-31' })).resolves.toMatchObject({
      error: expect.any(String),
    });
  });

  it('reports the full match count next to a limited page', async () => {
    const result = (await tool('tasks.list').execute(ctx(), { limit: 2 })) as { totalCount: number; tasks: unknown[] };
    expect(result.tasks).toHaveLength(2);
    expect(result.totalCount).toBeGreaterThan(2);
  });

  describe('row scope of the default WeldAgent', () => {
    it('hides tasks of projects the person is not in, but keeps what is theirs', async () => {
      const result = (await tool('tasks.list').execute(ctx(scoped()), { limit: 50 })) as {
        totalCount: number;
        tasks: Array<{ title: string }>;
      };
      const titles = result.tasks.map((t) => t.title).sort();
      // Own project, assigned to them anywhere, their personal errand; never Bob's secret or personal tasks.
      expect(titles).toContain('Overdue report');
      expect(titles).toContain('No due date');
      expect(titles).toContain('Assigned into secret');
      expect(titles).toContain('My own errand');
      expect(titles).not.toContain('Secret plan');
      expect(titles).not.toContain('Bob errand');
      expect(result.totalCount).toBe(result.tasks.length);
    });

    it('shows everything to someone with projects:scope:all', async () => {
      const result = (await tool('tasks.list').execute(ctx(scoped(true, true)), { limit: 50 })) as {
        tasks: Array<{ title: string }>;
      };
      const titles = result.tasks.map((t) => t.title);
      expect(titles).toContain('Secret plan');
      expect(titles).toContain('Bob errand');
      // A deleted project's tasks are gone for everyone.
      expect(titles).not.toContain('Ghost task');
    });
  });
});

describe('projects.list / projects.get', () => {
  it('counts tasks live (the stored counters are never maintained)', async () => {
    const result = (await tool('projects.list').execute(ctx(), { search: 'E2E' })) as {
      totalCount: number;
      projects: Array<{ id: string; name: string; status: string; openTasks: number; completedTasks: number; totalTasks: number }>;
    };
    expect(result.totalCount).toBe(1);
    expect(result.projects[0]).toMatchObject({
      name: 'E2E Project',
      status: 'Active',
      // todo + in_progress + todo + todo(task_nodue) = 4 open, 1 done, 5 in total.
      openTasks: 4,
      completedTasks: 1,
      totalTasks: 5,
    });
  });

  it('filters by status (any case) and leaves deleted projects out', async () => {
    const active = (await tool('projects.list').execute(ctx(), { status: 'active' })) as {
      projects: Array<{ name: string }>;
    };
    expect(active.projects.map((p) => p.name)).toEqual(['E2E Project']);
    const all = (await tool('projects.list').execute(ctx(), {})) as { projects: Array<{ name: string }> };
    expect(all.projects.map((p) => p.name)).not.toContain('Deleted Project');
  });

  it('gets a project by name or id, with its manager by name', async () => {
    const byName = (await tool('projects.get').execute(ctx(), { name: 'e2e project' })) as Record<string, unknown>;
    expect(byName).toMatchObject({
      id: 'prj_e2e',
      name: 'E2E Project',
      manager: 'Bob Other',
      totalTasks: 5,
      openTasks: 4,
      completedTasks: 1,
      progressPercent: 20,
    });
    const byId = (await tool('projects.get').execute(ctx(), { id: 'prj_e2e' })) as { name: string };
    expect(byId.name).toBe('E2E Project');
  });

  it('asks which project when a name is ambiguous, and needs an id or a name', async () => {
    const ambiguous = (await tool('projects.get').execute(ctx(), { name: 'Project' })) as {
      error: string;
      matches: Array<{ name: string }>;
    };
    expect(ambiguous.error).toContain('Several projects');
    expect(ambiguous.matches.map((m) => m.name).sort()).toEqual(['E2E Project', 'Secret Project']);
    await expect(tool('projects.get').execute(ctx(), {})).resolves.toMatchObject({ error: expect.any(String) });
    await expect(tool('projects.get').execute(ctx(), { id: 'prj_missing' })).resolves.toEqual({
      error: 'Project not found',
    });
  });

  it('prefers the exact name even when many other projects partly match it', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    const recent = new Date();
    await db.insert(schema.projects).values([
      { id: 'prj_zed', name: 'Zed', status: 'Active', createdAt: old, updatedAt: old },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `prj_zed_${i}`,
        name: `Zed ${i}`,
        status: 'Active',
        createdAt: recent,
        updatedAt: recent,
      })),
    ]);
    await expect(tool('projects.get').execute(ctx(), { name: 'zed' })).resolves.toMatchObject({
      id: 'prj_zed',
      name: 'Zed',
    });
    // A partial name that no project is called exactly stays ambiguous.
    await expect(tool('projects.get').execute(ctx(), { name: 'Zed ' })).resolves.toMatchObject({
      error: expect.stringContaining('Several projects'),
    });
    // Leave the workspace as the other tests expect it.
    await db.update(schema.projects).set({ deletedAt: new Date() }).where(like(schema.projects.id, 'prj_zed%'));
  });

  it('shows only the projects the person manages or belongs to unless they hold projects:scope:all', async () => {
    const mine = (await tool('projects.list').execute(ctx(scoped()), {})) as { projects: Array<{ name: string }> };
    expect(mine.projects.map((p) => p.name)).toEqual(['E2E Project']);
    await expect(tool('projects.get').execute(ctx(scoped()), { name: 'Secret' })).resolves.toEqual({
      error: 'Project not found',
    });

    const everything = (await tool('projects.list').execute(ctx(scoped(false, true)), {})) as {
      projects: Array<{ name: string }>;
    };
    expect(everything.projects.map((p) => p.name).sort()).toEqual(['E2E Project', 'Secret Project']);
  });

  it('sees nothing when the person belongs to no project', async () => {
    const stranger = ctx({ actorUserId: 'user_stranger', rowScope: { userId: 'user_stranger', allPeople: false, allProjects: false } });
    await expect(tool('projects.list').execute(stranger, {})).resolves.toEqual({ totalCount: 0, projects: [] });
  });
});

describe('people tools', () => {
  it('limit a person without people:scope:all to the people they own', async () => {
    await db.insert(schema.people).values([
      { id: 'per_mine', firstName: 'Mina', lastName: 'Mine', fullName: 'Mina Mine', displayName: 'Mina Mine', ownerId: ME, inCrm: true },
      { id: 'per_bobs', firstName: 'Bobby', lastName: 'Theirs', fullName: 'Bobby Theirs', displayName: 'Bobby Theirs', ownerId: BOB, inCrm: true },
    ]);

    const names = async (c: ToolContext) =>
      ((await tool('people.list').execute(c, { search: 'M' })) as { people: Array<{ fullName: string }> }).people.map(
        (p) => p.fullName,
      );
    expect(await names(ctx(scoped()))).toEqual(['Mina Mine']);
    // No row scope (a workspace agent) or people:scope:all sees both.
    expect(await names(ctx())).toContain('Mina Mine');
    const all = (await tool('people.list').execute(ctx(scoped(true)), { search: 'Theirs' })) as {
      people: Array<{ fullName: string }>;
    };
    expect(all.people.map((p) => p.fullName)).toEqual(['Bobby Theirs']);

    await expect(tool('people.get').execute(ctx(scoped()), { id: 'per_bobs' })).resolves.toEqual({
      error: 'Person not found',
    });
    await expect(tool('people.get').execute(ctx(scoped()), { id: 'per_mine' })).resolves.toMatchObject({
      fullName: 'Mina Mine',
    });
  });
});
