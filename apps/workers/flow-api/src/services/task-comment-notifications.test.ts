/**
 * Task-comment notifications — pglite-backed: who gets a `mention`, who gets
 * a `task_comment`, and that mentions never reach someone outside the project.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { extractMentionedUserIds, taskCommentRecipients } from '@weldsuite/notifications';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { notifyTaskComment } from './task-comment-notifications';
import type { Env } from '../types';

const { notifications, projects, projectMembers, tasks, workspaceMembers } = schema;

const AUTHOR = 'user_author';
const ASSIGNEE = 'user_assignee';
const REPORTER = 'user_reporter';
const MEMBER = 'user_member';
const OUTSIDER = 'user_outsider';

// No REALTIME / SEND_EMAIL bindings: the orchestrator still writes the row,
// in-app publish and email become no-ops.
const env = {} as Env;

let db: Database;
let projectId: string;
let taskId: string;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();

  projectId = generateId('proj');
  await db.insert(projects).values({
    id: projectId,
    name: 'Comment Test Project',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as typeof projects.$inferInsert);

  for (const userId of [AUTHOR, ASSIGNEE, REPORTER, MEMBER, OUTSIDER]) {
    await db.insert(workspaceMembers).values({ id: generateId('wm'), userId, name: userId });
  }
  for (const userId of [AUTHOR, ASSIGNEE, REPORTER, MEMBER]) {
    await db.insert(projectMembers).values({ id: generateId('pm'), projectId, userId, role: 'member' });
  }

  taskId = generateId('task');
  await db.insert(tasks).values({
    id: taskId,
    title: 'Write the spec',
    projectId,
    assigneeId: ASSIGNEE,
    reporterId: REPORTER,
    createdAt: now,
    updatedAt: now,
  } as typeof tasks.$inferInsert);
}, 60_000);

beforeEach(async () => {
  await db.delete(notifications);
});

async function notificationsFor(userId: string) {
  return db.select().from(notifications).where(eq(notifications.userId, userId));
}

describe('extractMentionedUserIds', () => {
  it('returns unique ids in order', () => {
    expect(extractMentionedUserIds('hi <@user_a> and <@user_b>, <@user_a>')).toEqual(['user_a', 'user_b']);
  });

  it('returns nothing without tokens', () => {
    expect(extractMentionedUserIds('no mentions @here')).toEqual([]);
  });
});

describe('taskCommentRecipients', () => {
  it('drops the author and gives a mentioned watcher only the mention', () => {
    expect(
      taskCommentRecipients({
        authorId: 'a',
        mentionedUserIds: ['a', 'b'],
        watcherIds: ['a', 'b', 'c', 'c'],
      }),
    ).toEqual({ mentioned: ['b'], watchers: ['c'] });
  });
});

describe('notifyTaskComment', () => {
  it('notifies assignee and reporter, not the author', async () => {
    await notifyTaskComment({
      db,
      env,
      workspaceId: 'org_test',
      authorId: AUTHOR,
      commentId: generateId('tcmt'),
      taskId,
      content: 'Looks good',
    });

    const [assignee] = await notificationsFor(ASSIGNEE);
    expect(assignee?.notificationType).toBe('task_comment');
    expect(assignee?.actionUrl).toBe(`/weldflow/task/${taskId}`);
    expect(await notificationsFor(REPORTER)).toHaveLength(1);
    expect(await notificationsFor(AUTHOR)).toHaveLength(0);
  });

  it('sends a mention to a project member and skips a non-member', async () => {
    await notifyTaskComment({
      db,
      env,
      workspaceId: 'org_test',
      authorId: AUTHOR,
      commentId: generateId('tcmt'),
      taskId,
      content: `<@${MEMBER}> <@${OUTSIDER}> <@${ASSIGNEE}> please check`,
    });

    const [member] = await notificationsFor(MEMBER);
    expect(member?.notificationType).toBe('mention');
    expect(await notificationsFor(OUTSIDER)).toHaveLength(0);
    // The assignee is mentioned, so gets one notification (the mention), not two.
    const assignee = await notificationsFor(ASSIGNEE);
    expect(assignee.map((n) => n.notificationType)).toEqual(['mention']);
  });
});
