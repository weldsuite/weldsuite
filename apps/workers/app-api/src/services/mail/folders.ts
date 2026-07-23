/**
 * Mail folder service.
 *
 * Folders live alongside accounts (one-to-many). Most "folders" the user
 * sees in the inbox are actually labels (`mail_labels`) — this table is
 * for IMAP-style folder hierarchies and provider-side counts. System
 * folders (`isSystem = true`) are read-only via the route layer.
 */

import { and, asc, eq, isNull, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import { generateId } from '../../lib/id';

const { mailFolders } = schema;

export class MailFolderError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'SYSTEM_FOLDER_IMMUTABLE', message: string) {
    super(message);
    this.name = 'MailFolderError';
  }
}

type FolderType = 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash' | 'archive' | 'custom';

export async function listFolders(db: Database, accountId?: string) {
  const conditions: SQL[] = [isNull(mailFolders.deletedAt)!];
  if (accountId) conditions.push(eq(mailFolders.accountId, accountId));
  return db
    .select()
    .from(mailFolders)
    .where(and(...conditions))
    .orderBy(asc(mailFolders.position), asc(mailFolders.name));
}

export async function getFolder(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailFolders)
    .where(and(eq(mailFolders.id, id), isNull(mailFolders.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface FolderInput {
  accountId: string;
  name: string;
  type?: FolderType;
  parentId?: string;
  path?: string;
  color?: string;
  icon?: string;
  position?: number;
}

export async function createFolder(db: Database, data: FolderInput) {
  const id = generateId('mfld');
  const now = new Date();
  await db.insert(mailFolders).values({
    id,
    accountId: data.accountId,
    name: data.name,
    type: data.type ?? 'custom',
    parentId: data.parentId,
    path: data.path,
    color: data.color,
    icon: data.icon,
    position: data.position ?? 0,
    isSelectable: true,
    isSystem: false,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(mailFolders).where(eq(mailFolders.id, id));
  return row!;
}

export async function updateFolder(db: Database, id: string, data: Partial<FolderInput>) {
  const [existing] = await db
    .select()
    .from(mailFolders)
    .where(and(eq(mailFolders.id, id), isNull(mailFolders.deletedAt)))
    .limit(1);
  if (!existing) throw new MailFolderError('NOT_FOUND', 'Folder not found');

  if (existing.isSystem) {
    // System folders can be repositioned, recoloured, or hidden, but the
    // identity-defining fields (name, type, parentId) are locked so
    // provider sync doesn't desync.
    const locked = ['name', 'type', 'parentId', 'path'] as const;
    for (const key of locked) {
      if ((data as Record<string, unknown>)[key] !== undefined) {
        throw new MailFolderError(
          'SYSTEM_FOLDER_IMMUTABLE',
          `Field "${key}" cannot be changed on a system folder.`,
        );
      }
    }
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  await db
    .update(mailFolders)
    .set(patch as typeof mailFolders.$inferInsert)
    .where(eq(mailFolders.id, id));
  const [after] = await db.select().from(mailFolders).where(eq(mailFolders.id, id));
  return { before: existing, after: after! };
}

export async function softDeleteFolder(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailFolders)
    .where(and(eq(mailFolders.id, id), isNull(mailFolders.deletedAt)))
    .limit(1);
  if (!existing) return null;
  if (existing.isSystem) {
    throw new MailFolderError('SYSTEM_FOLDER_IMMUTABLE', 'System folders cannot be deleted.');
  }
  await db
    .update(mailFolders)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailFolders.id, id));
  return existing;
}
