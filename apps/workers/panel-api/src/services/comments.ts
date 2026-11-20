/**
 * Comments on a report or a dashboard, and the in-app notification its owner
 * gets when someone else comments (through `@weldsuite/notifications`, in the
 * owner's language, English or Dutch). Only people who may see the target read
 * or write its comments; editing is for the author, deleting for the author or
 * `panel_projects:manage`.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { createAndDeliverNotification, notificationPreview } from '@weldsuite/notifications';
import type { Database as NotificationDb, NotificationEnv } from '@weldsuite/notifications/types';
import { resolveEmailLocale } from '@weldsuite/emails';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelComment } from '@weldsuite/db/schema';
import type { PanelCommentDto, PanelTargetType } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { Env } from '../types';
import type { PanelTarget } from './saved-objects';

const { panelComments, userPreferences, workspaceMembers, workspaceSettings } = schema;

/** Comments listed per target, oldest first. */
export const MAX_LISTED_COMMENTS = 500;

export function toCommentDto(c: PanelComment): PanelCommentDto {
  return {
    id: c.id,
    projectId: c.projectId,
    targetType: c.targetType,
    targetId: c.targetId,
    body: c.body,
    authorUserId: c.authorUserId,
    edited: c.updatedAt.getTime() - c.createdAt.getTime() > 1000,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** The payload of a `panel_comment` event: never the body. */
export function commentEventData(c: PanelComment) {
  return { id: c.id, projectId: c.projectId, targetType: c.targetType, targetId: c.targetId, authorUserId: c.authorUserId };
}

export async function listComments(db: Database, targetType: PanelTargetType, targetId: string): Promise<PanelComment[]> {
  return db
    .select()
    .from(panelComments)
    .where(and(eq(panelComments.targetType, targetType), eq(panelComments.targetId, targetId), isNull(panelComments.deletedAt)))
    .orderBy(asc(panelComments.createdAt), asc(panelComments.id))
    .limit(MAX_LISTED_COMMENTS);
}

export async function getComment(db: Database, id: string): Promise<PanelComment | null> {
  const [row] = await db.select().from(panelComments).where(and(eq(panelComments.id, id), isNull(panelComments.deletedAt))).limit(1);
  return row ?? null;
}

export async function createComment(db: Database, target: PanelTarget, body: string, userId: string): Promise<PanelComment> {
  const [row] = await db
    .insert(panelComments)
    .values({
      id: generateId('pncm'),
      projectId: target.row.projectId,
      targetType: target.targetType,
      targetId: target.row.id,
      body,
      authorUserId: userId,
    })
    .returning();
  return row as PanelComment;
}

export async function updateComment(db: Database, id: string, body: string): Promise<PanelComment | null> {
  const [row] = await db
    .update(panelComments)
    .set({ body, updatedAt: new Date() })
    .where(and(eq(panelComments.id, id), isNull(panelComments.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteComment(db: Database, id: string): Promise<PanelComment | null> {
  const [row] = await db
    .update(panelComments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(panelComments.id, id), isNull(panelComments.deletedAt)))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Notification to the target's owner
// ---------------------------------------------------------------------------

type CommentLocale = 'en' | 'nl';

const COPY: Record<CommentLocale, { report: string; dashboard: string; someone: string }> = {
  en: { report: '{author} commented on the report "{name}"', dashboard: '{author} commented on the dashboard "{name}"', someone: 'Someone' },
  nl: { report: '{author} reageerde op het rapport "{name}"', dashboard: '{author} reageerde op het dashboard "{name}"', someone: 'Iemand' },
};

/** Where the platform opens each report kind's builder (the platform's `REPORT_BUILDER_PATHS`). */
const REPORT_PATHS: Record<string, string> = {
  web: '/weldpanel',
  trends: '/weldpanel/insights',
  funnel: '/weldpanel/funnels',
  retention: '/weldpanel/retention',
  flows: '/weldpanel/flows',
};

/** The platform path that opens the target. */
export function targetPath(target: PanelTarget): string {
  if (target.targetType === 'dashboard') return `/weldpanel/dashboards/${target.row.id}`;
  const path = REPORT_PATHS[target.row.kind] ?? '/weldpanel/reports';
  return `${path}?report=${encodeURIComponent(target.row.id)}`;
}

/** The notification's title, in `locale`. */
export function commentTitle(locale: CommentLocale, targetType: PanelTargetType, authorName: string | null, targetName: string): string {
  const copy = COPY[locale];
  return copy[targetType].replace('{author}', authorName || copy.someone).replace('{name}', targetName);
}

async function recipientLocale(db: Database, userId: string): Promise<CommentLocale> {
  const [pref] = await db.select({ language: userPreferences.language }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  const [settings] = await db.select({ language: workspaceSettings.language }).from(workspaceSettings).limit(1);
  const locale = resolveEmailLocale(pref?.language, settings?.language);
  return locale === 'nl' ? 'nl' : 'en';
}

async function memberName(db: Database, userId: string): Promise<string | null> {
  const [row] = await db.select({ name: workspaceMembers.name }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId)).limit(1);
  return row?.name ?? null;
}

export interface CommentNotice {
  env: Env;
  db: Database;
  /** Clerk org id: the WorkspaceHub the in-app notification is published on. */
  clerkOrgId: string;
  target: PanelTarget;
  comment: PanelComment;
}

/**
 * Tells the target's owner about a new comment, in-app only, unless the owner
 * wrote it. Never throws: a failure is logged and the comment stands.
 */
export async function notifyTargetOwner(notice: CommentNotice): Promise<boolean> {
  const { env, db, clerkOrgId, target, comment } = notice;
  const ownerId = target.row.ownerUserId;
  if (ownerId === comment.authorUserId) return false;
  try {
    const [locale, authorName] = await Promise.all([recipientLocale(db, ownerId), memberName(db, comment.authorUserId)]);
    const id = await createAndDeliverNotification({
      db: db as unknown as NotificationDb,
      env: { ...env, PUBLIC_APP_URL: env.PLATFORM_URL } as unknown as NotificationEnv,
      workspaceId: clerkOrgId,
      clerkOrgId,
      userId: ownerId,
      title: commentTitle(locale, target.targetType, authorName, target.row.name).slice(0, 255),
      body: notificationPreview(comment.body),
      category: 'system',
      notificationType: 'comment',
      entityType: 'panel_comment',
      entityId: comment.id,
      actionUrl: targetPath(target),
      severity: 'info',
      actorType: 'user',
      actorId: comment.authorUserId,
      // In-app only: the panel has no comment email template and no mobile app.
      excludeChannels: ['email', 'push'],
    });
    return id !== null;
  } catch (err) {
    console.error('[panel-api] comment notification failed', err);
    return false;
  }
}
