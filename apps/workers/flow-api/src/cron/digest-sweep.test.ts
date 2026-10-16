/**
 * Task digest (TASK-776): which tasks the per-user digest lists, and how the
 * hourly sweep retries a workspace after a failed pass.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { dayBoundsInTimezone } from '@weldsuite/flow-domain/day-boundaries';
import { queryDigestTasks } from '@weldsuite/flow-domain/workflows/send-digest';
import { CATCH_UP_HOURS, dispatchMemberDigest, isDue } from './digest-sweep';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();
  await db.insert(schema.projects).values([
    { id: 'proj_dg', name: 'Live project', createdAt: now, updatedAt: now },
    { id: 'proj_dg_dead', name: 'Dead project', deletedAt: now, createdAt: now, updatedAt: now },
  ] as (typeof schema.projects.$inferInsert)[]);
}, 60_000);

const ME = 'user_digest';
const allSections = { overdue: true, dueToday: true, dueThisWeek: true };
const bothTypes = { projectTasks: true, personalTasks: true };
const seed = (values: Record<string, unknown>) =>
  db.insert(schema.tasks).values({ title: 'T', ...values } as typeof schema.tasks.$inferInsert);
const titles = (tasks: { title: string }[]) => tasks.map((task) => task.title).sort();

// Amsterdam in July is UTC+2: local midnight is 22:00Z the day before.
const NOW = new Date('2031-07-10T10:00:00.000Z'); // Thursday
const bounds = dayBoundsInTimezone('Europe/Amsterdam', NOW);
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number, from = bounds.startOfToday) => new Date(from.getTime() + offsetMs);

describe('queryDigestTasks', () => {
  it('lists a personal task once, in its own section, and honours the personal-tasks switch', async () => {
    await seed({ id: 'dg_personal', title: 'personal today', assigneeId: ME, dueDate: at(2 * HOUR) });
    await seed({ id: 'dg_project', title: 'project today', assigneeId: ME, projectId: 'proj_dg', dueDate: at(3 * HOUR) });

    const both = await queryDigestTasks(db, ME, bounds, bothTypes, allSections);
    expect(titles(both.dueToday)).toEqual(['personal today', 'project today']);
    const personal = both.dueToday.find((task) => task.title === 'personal today');
    expect(personal?.type).toBe('personal');
    expect(personal?.projectName).toBeNull();

    const noPersonal = await queryDigestTasks(db, ME, bounds, { projectTasks: true, personalTasks: false }, allSections);
    expect(titles(noPersonal.dueToday)).toEqual(['project today']);
    const noProject = await queryDigestTasks(db, ME, bounds, { projectTasks: false, personalTasks: true }, allSections);
    expect(titles(noProject.dueToday)).toEqual(['personal today']);
  });

  it('cuts the day in the workspace time zone: due at local midnight is today, an hour before is overdue', async () => {
    await seed({ id: 'dg_midnight', title: 'at midnight', assigneeId: ME, dueDate: bounds.startOfToday });
    await seed({ id: 'dg_before', title: 'before midnight', assigneeId: ME, dueDate: at(-HOUR) });

    const result = await queryDigestTasks(db, ME, bounds, bothTypes, allSections);
    expect(result.dueToday.map((task) => task.title)).toContain('at midnight');
    expect(result.overdue.map((task) => task.title)).toContain('before midnight');
    expect(result.overdue.map((task) => task.title)).not.toContain('at midnight');
  });

  it('includes tasks the user holds through assigneeIds, and nobody else’s', async () => {
    await seed({ id: 'dg_multi', title: 'multi', assigneeId: 'user_first', assigneeIds: ['user_first', ME], dueDate: at(HOUR) });
    await seed({ id: 'dg_other', title: 'someone else', assigneeId: 'user_first', dueDate: at(HOUR) });

    const result = await queryDigestTasks(db, ME, bounds, bothTypes, allSections);
    expect(result.dueToday.map((task) => task.title)).toContain('multi');
    expect(result.dueToday.map((task) => task.title)).not.toContain('someone else');
  });

  it('lists this week from tomorrow up to next Monday, and skips done and deleted tasks and dead projects', async () => {
    await seed({ id: 'dg_fri', title: 'friday', assigneeId: ME, dueDate: at(HOUR, bounds.startOfTomorrow) });
    await seed({ id: 'dg_nextweek', title: 'next monday', assigneeId: ME, dueDate: bounds.startOfNextWeek });
    await seed({ id: 'dg_done', title: 'finished', assigneeId: ME, status: 'done', dueDate: at(HOUR) });
    await seed({ id: 'dg_deleted', title: 'removed', assigneeId: ME, deletedAt: new Date(), dueDate: at(HOUR) });
    await seed({ id: 'dg_deadproj', title: 'dead project task', assigneeId: ME, projectId: 'proj_dg_dead', dueDate: at(HOUR) });

    const result = await queryDigestTasks(db, ME, bounds, bothTypes, allSections);
    expect(result.dueThisWeek.map((task) => task.title)).toContain('friday');
    const everything = [...result.overdue, ...result.dueToday, ...result.dueThisWeek].map((task) => task.title);
    for (const hidden of ['next monday', 'finished', 'removed', 'dead project task']) {
      expect(everything).not.toContain(hidden);
    }
  });

  it('skips the sections that are switched off', async () => {
    const result = await queryDigestTasks(db, ME, bounds, bothTypes, { overdue: false, dueToday: true, dueThisWeek: false });
    expect(result.overdue).toEqual([]);
    expect(result.dueThisWeek).toEqual([]);
    expect(result.dueToday.length).toBeGreaterThan(0);
  });
});

describe('sweep window', () => {
  it('is due at the send hour and through the catch-up window, never before or past it', () => {
    expect(isDue(7, 8)).toBe(false);
    expect(isDue(8, 8)).toBe(true);
    expect(isDue(8 + CATCH_UP_HOURS - 1, 8)).toBe(true);
    expect(isDue(8 + CATCH_UP_HOURS, 8)).toBe(false);
  });

  it('does not wrap past midnight into the next day’s date', () => {
    expect(isDue(0, 23)).toBe(false);
    expect(isDue(1, 23)).toBe(false);
  });
});

describe('dispatchMemberDigest', () => {
  type Workflow = Parameters<typeof dispatchMemberDigest>[0];
  const member = { userId: 'u1', email: 'u1@example.com', name: 'U One' };
  const rejecting = (message: string) =>
    ({
      create: async () => {
        throw new Error(message);
      },
    }) as unknown as Workflow;
  const created: string[] = [];
  const workflow = {
    create: async ({ id }: { id: string }) => {
      created.push(id);
    },
  } as unknown as Workflow;

  it('dispatches under a per-day instance id', async () => {
    expect(await dispatchMemberDigest(workflow, undefined, 'org_1', member, 'UTC', '2031-07-10')).toBe('dispatched');
    expect(created).toEqual(['digest-org_1-u1-2031-07-10']);
  });

  it('reports an existing instance as already sent, so a retry pass skips the member', async () => {
    const result = await dispatchMemberDigest(
      rejecting('instance.already_exists'),
      undefined,
      'org_1',
      member,
      'UTC',
      '2031-07-10',
    );
    expect(result).toBe('already-sent');
  });

  it('rethrows any other failure so the member is retried', async () => {
    await expect(
      dispatchMemberDigest(rejecting('network down'), undefined, 'org_1', member, 'UTC', '2031-07-10'),
    ).rejects.toThrow('network down');
  });

  it('skips members without an email or who opted out', async () => {
    expect(await dispatchMemberDigest(workflow, undefined, 'org_1', { ...member, email: null }, 'UTC', '2031-07-10')).toBe(
      'skipped',
    );
    expect(
      await dispatchMemberDigest(workflow, { doNotDisturb: true, modulePreferences: null }, 'org_1', member, 'UTC', '2031-07-10'),
    ).toBe('skipped');
    expect(
      await dispatchMemberDigest(
        workflow,
        { doNotDisturb: false, modulePreferences: { digest: { enabled: false } } },
        'org_1',
        member,
        'UTC',
        '2031-07-10',
      ),
    ).toBe('skipped');
  });
});
