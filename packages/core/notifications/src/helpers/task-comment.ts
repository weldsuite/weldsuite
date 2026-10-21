/**
 * Task-comment notifications — fire when someone comments on a task.
 *
 *   - Users @-mentioned in the comment (`<@userId>` tokens) get a `mention`.
 *   - The task's assignees and reporter who were not mentioned get a
 *     `task_comment`.
 *
 * The author never notifies themselves. Callers decide who may be notified
 * (e.g. project access for mentions) and pass the final recipient sets.
 */

import { createAndDeliverNotification } from '../orchestrator';
import type { Database, NotificationEnv } from '../types';

const MENTION_TOKEN = /<@([^>\s]+)>/g;

/** Unique user ids @-mentioned in a comment body, in order of appearance. */
export function extractMentionedUserIds(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(MENTION_TOKEN)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

/**
 * Split recipients into mentions and plain watchers: a mentioned watcher gets
 * the mention only, and the author is dropped from both.
 */
export function taskCommentRecipients(opts: {
  authorId: string;
  mentionedUserIds: string[];
  watcherIds: string[];
}): { mentioned: string[]; watchers: string[] } {
  const mentioned = [...new Set(opts.mentionedUserIds)].filter((id) => id && id !== opts.authorId);
  const mentionedSet = new Set(mentioned);
  const watchers = [...new Set(opts.watcherIds)].filter(
    (id) => id && id !== opts.authorId && !mentionedSet.has(id),
  );
  return { mentioned, watchers };
}

interface TaskCommentParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  /** Clerk org id of the workspace. */
  workspaceId: string;
  recipientId: string;
  kind: 'mention' | 'comment';
  authorId: string;
  authorName: string;
  taskId: string;
  taskTitle: string;
  commentId: string;
  /** Raw comment body; `<@userId>` tokens stay in, the panel renders them. */
  content: string;
  category: 'projects' | 'crm';
  actionUrl: string;
  projectId?: string | null;
}

export async function sendTaskCommentNotification<Env extends NotificationEnv>(
  params: TaskCommentParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, recipientId, kind, authorId, authorName, taskId, taskTitle, commentId, content } = params;
  if (recipientId === authorId) return null;

  const preview = content.replace(/\s+/g, ' ').trim().slice(0, 180);
  const title =
    kind === 'mention'
      ? `${authorName} mentioned you on "${taskTitle}"`
      : `${authorName} commented on "${taskTitle}"`;

  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId: recipientId,
    title: title.slice(0, 255),
    body: preview,
    category: params.category,
    notificationType: kind === 'mention' ? 'mention' : 'task_comment',
    entityType: 'task',
    entityId: taskId,
    actionUrl: params.actionUrl,
    severity: 'info',
    actorType: 'user',
    actorId: authorId,
    data: {
      taskId,
      commentId,
      ...(params.projectId ? { projectId: params.projectId } : {}),
    },
  });
}
