/**
 * pglite-backed access tests for the unified drive feed and its counters.
 *
 * Mail attachments are the one drive source with per-record access: a file
 * name from a private mailbox must only reach the users who may open that
 * mailbox (`@weldsuite/mail-domain/access`). `files:read` alone is not enough,
 * and neither is the admin/owner role.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { aggregateAllFiles, aggregateStats, listPurgedFileKeys, normalizeGenericFiles, purgeTrashed } from './drive-aggregation';
import { purgeFolder } from './folders';
import { listDocumentSnapshotKeys, purgeFile } from '@weldsuite/core-domain/files';
import { eq } from 'drizzle-orm';
import { isPlatformRoute } from '../test/platform-routes';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailAttachments, mailMessages, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const OWNER = 'user_owner';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

let db: Database;

async function seedMember(userId: string, role: string) {
  const now = new Date();
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@test.dev`,
    role,
    createdAt: now,
    updatedAt: now,
  } as typeof workspaceMembers.$inferInsert);
}

/** One account holding one message with one attachment named `fileName`. */
async function seedMailbox(
  fileName: string,
  account: Partial<typeof mailAccounts.$inferInsert>,
  attachment: Partial<typeof mailAttachments.$inferInsert> = {},
) {
  const accountId = generateId('mail');
  await db
    .insert(mailAccounts)
    .values({ id: accountId, name: 'Test', email: `${accountId}@test.dev`, ...account });

  const messageId = generateId('mmsg');
  await db.insert(mailMessages).values({
    id: messageId,
    accountId,
    threadId: `thread_${messageId}`,
    messageId: `<${messageId}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Drive test',
    sentDate: new Date(),
    labels: ['INBOX'],
  });

  await db
    .insert(mailAttachments)
    .values({ id: generateId('matt'), messageId, fileName, ...attachment });
}

async function mailFileNames(userId: string): Promise<string[]> {
  const files = await aggregateAllFiles(db, { userId, source: 'mail' });
  return files.map((f) => f.name).sort();
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedMember(ADMIN, 'ADMIN');
  await seedMember(OWNER, 'OWNER');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  await seedMailbox('shared.pdf', { isShared: true });
  await seedMailbox('private.pdf', { isShared: false, assignedUserIds: [ASSIGNEE] });
  await seedMailbox('unassigned.pdf', { isShared: false, assignedUserIds: null });
  await seedMailbox('removed.pdf', { isShared: true }, { deletedAt: new Date() });
  await seedMailbox('closed-account.pdf', { isShared: true, deletedAt: new Date() });
}, 60_000);

/** A trashed WeldSheets spreadsheet: its file plus the `sheets` row that references it. */
async function seedTrashedSheet(): Promise<string> {
  const fileId = generateId('fil');
  await db.insert(schema.files).values({
    id: fileId,
    fileName: 'Budget',
    mimeType: 'application/vnd.weldsuite.spreadsheet',
    fileSize: 1,
    fileType: 'spreadsheet',
    storagePath: `workspaces/w/sheets/${fileId}/workbook.json.gz`,
    deletedAt: new Date(),
  });
  await db.insert(schema.sheets).values({ id: generateId('sht'), fileId });
  return fileId;
}

describe('purging a WeldSheets spreadsheet', () => {
  it.each([
    ['from the trash list', (fileId: string) => purgeTrashed(db, { fileIds: [fileId], folderIds: [] })],
    ['one file', (fileId: string) => purgeFile(db, fileId)],
  ])('removes its sheet row with the file (%s)', async (_label, purge) => {
    const fileId = await seedTrashedSheet();
    await purge(fileId);
    expect(await db.select().from(schema.files).where(eq(schema.files.id, fileId))).toEqual([]);
    expect(await db.select().from(schema.sheets).where(eq(schema.sheets.fileId, fileId))).toEqual([]);
  });
});

/** A trashed WeldDocs document: its file, a version of an older document, and the `docs` row that references them. */
async function seedTrashedDoc(): Promise<string> {
  const fileId = generateId('fil');
  await db.insert(schema.files).values({
    id: fileId,
    fileName: 'Plan',
    mimeType: 'application/vnd.weldsuite.doc+json',
    fileSize: 1,
    fileType: 'document',
    storagePath: `workspaces/w/docs/${fileId}/document.json.gz`,
    deletedAt: new Date(),
  });
  await db.insert(schema.docs).values({ id: generateId('doc'), fileId, content: null, snapshotKey: 'k' });
  await db.insert(schema.documentVersions).values({ id: generateId('docver'), fileId, content: [] });
  return fileId;
}

describe('purging a WeldDocs document', () => {
  it.each([
    ['from the trash list', (fileId: string) => purgeTrashed(db, { fileIds: [fileId], folderIds: [] })],
    ['one file', (fileId: string) => purgeFile(db, fileId)],
  ])('removes its docs row with the file (%s)', async (_label, purge) => {
    const fileId = await seedTrashedDoc();
    await purge(fileId);
    expect(await db.select().from(schema.files).where(eq(schema.files.id, fileId))).toEqual([]);
    expect(await db.select().from(schema.docs).where(eq(schema.docs.fileId, fileId))).toEqual([]);
    expect(await db.select().from(schema.documentVersions).where(eq(schema.documentVersions.fileId, fileId))).toEqual([]);
  });
});

/**
 * A trashed document and spreadsheet, each with a checkpoint snapshot and
 * saved versions (two and one); the spreadsheet was an old project sheet, so
 * it keeps the .xlsx it was converted from.
 */
async function seedTrashedSnapshots(tag: string, folderId: string | null = null) {
  const docFile = generateId('fil');
  const sheetFile = generateId('fil');
  for (const [id, mime, type] of [
    [docFile, 'application/vnd.weldsuite.doc+json', 'document'],
    [sheetFile, 'application/vnd.weldsuite.spreadsheet', 'spreadsheet'],
  ] as const) {
    await db.insert(schema.files).values({
      id,
      fileName: `${tag}-${type}`,
      mimeType: mime,
      fileSize: 1,
      fileType: type,
      storagePath: `workspaces/w/${tag}/${id}`,
      folderId,
      deletedAt: new Date(),
    });
  }
  const docId = generateId('doc');
  await db.insert(schema.docs).values({ id: docId, fileId: docFile, content: null, snapshotKey: `${tag}/doc/document.json.gz` });
  await db.insert(schema.docVersions).values([
    { id: generateId('docv'), docId, revision: 1, snapshotKey: `${tag}/doc/versions/a.json.gz` },
    { id: generateId('docv'), docId, revision: 2, snapshotKey: `${tag}/doc/versions/b.json.gz` },
  ]);
  const sheetId = generateId('sht');
  await db.insert(schema.sheets).values({ id: sheetId, fileId: sheetFile, snapshotKey: `${tag}/sheet/workbook.json.gz` });
  await db.insert(schema.sheetVersions).values({ id: generateId('shv'), sheetId, revision: 3, snapshotKey: `${tag}/sheet/versions/a.json.gz` });
  await db
    .update(schema.files)
    .set({ metadata: { weldsheetId: sheetId, convertedFrom: { key: `${tag}/old-grid.xlsx`, at: '2026-10-25T00:00:00.000Z' } } })
    .where(eq(schema.files.id, sheetFile));
  return { docFile, sheetFile };
}

describe('purging a document or spreadsheet removes its R2 snapshots too', () => {
  it('lists the file, checkpoint and version keys of what the trash purge removes', async () => {
    const { docFile, sheetFile } = await seedTrashedSnapshots('trash-list');
    const keys = await listPurgedFileKeys(db, { fileIds: [docFile, sheetFile], folderIds: [] });
    expect(keys.sort()).toEqual(
      [
        `workspaces/w/trash-list/${docFile}`,
        `workspaces/w/trash-list/${sheetFile}`,
        'trash-list/doc/document.json.gz',
        'trash-list/doc/versions/a.json.gz',
        'trash-list/doc/versions/b.json.gz',
        'trash-list/sheet/workbook.json.gz',
        'trash-list/sheet/versions/a.json.gz',
        'trash-list/old-grid.xlsx',
      ].sort(),
    );
  });

  it('leaves out the snapshots of a file that is not being purged', async () => {
    const kept = await seedTrashedSnapshots('trash-kept');
    const purged = await seedTrashedSnapshots('trash-purged');
    const keys = await listPurgedFileKeys(db, { fileIds: [purged.docFile], folderIds: [] });
    expect(keys).toContain('trash-purged/doc/versions/a.json.gz');
    expect(keys.some((k) => k.includes('trash-kept') || k.includes(kept.docFile))).toBe(false);
    expect(keys.some((k) => k.includes('sheet'))).toBe(false);
  });

  it('lists the snapshots of every file in a purged folder', async () => {
    const folderId = generateId('fld');
    await db.insert(schema.folders).values({ id: folderId, name: 'Old', deletedAt: new Date() });
    await seedTrashedSnapshots('trash-folder', folderId);
    const keys = await listPurgedFileKeys(db, { fileIds: [], folderIds: [folderId] });
    expect(keys).toEqual(
      expect.arrayContaining([
        'trash-folder/doc/document.json.gz',
        'trash-folder/doc/versions/b.json.gz',
        'trash-folder/sheet/workbook.json.gz',
        'trash-folder/sheet/versions/a.json.gz',
        'trash-folder/old-grid.xlsx',
      ]),
    );
  });

  it('lists them for one file by id, and nothing for a plain file or no ids', async () => {
    const { docFile, sheetFile } = await seedTrashedSnapshots('trash-one');
    expect((await listDocumentSnapshotKeys(db, [docFile])).sort()).toEqual([
      'trash-one/doc/document.json.gz',
      'trash-one/doc/versions/a.json.gz',
      'trash-one/doc/versions/b.json.gz',
    ]);
    // A spreadsheet's saved versions, and the .xlsx an old project sheet was converted from.
    expect((await listDocumentSnapshotKeys(db, [sheetFile])).sort()).toEqual([
      'trash-one/old-grid.xlsx',
      'trash-one/sheet/versions/a.json.gz',
      'trash-one/sheet/workbook.json.gz',
    ]);
    expect(await listDocumentSnapshotKeys(db, [])).toEqual([]);
    expect(await listDocumentSnapshotKeys(db, ['fil_unknown'])).toEqual([]);
  });

  it('purgeFolder removes the documents and spreadsheets in the folder along with their files', async () => {
    const folderId = generateId('fld');
    await db.insert(schema.folders).values({ id: folderId, name: 'Gone', deletedAt: new Date() });
    const { docFile, sheetFile } = await seedTrashedSnapshots('folder-purge', folderId);
    await purgeFolder(db, folderId);
    expect(await db.select().from(schema.files).where(eq(schema.files.folderId, folderId))).toEqual([]);
    expect(await db.select().from(schema.docs).where(eq(schema.docs.fileId, docFile))).toEqual([]);
    expect(await db.select().from(schema.sheets).where(eq(schema.sheets.fileId, sheetFile))).toEqual([]);
  });
});

describe('aggregateAllFiles · mail attachments', () => {
  it('lists only shared-mailbox attachments for an unassigned member', async () => {
    expect(await mailFileNames(MEMBER)).toEqual(['shared.pdf']);
  });

  it('adds a private mailbox for its assignee', async () => {
    expect(await mailFileNames(ASSIGNEE)).toEqual(['private.pdf', 'shared.pdf']);
  });

  it('gives admins and owners the unassigned mailbox but not a colleague\'s private one', async () => {
    expect(await mailFileNames(ADMIN)).toEqual(['shared.pdf', 'unassigned.pdf']);
    expect(await mailFileNames(OWNER)).toEqual(['shared.pdf', 'unassigned.pdf']);
  });

  it('applies the same scope to the unfiltered feed', async () => {
    const names = (await aggregateAllFiles(db, { userId: MEMBER })).map((f) => f.name);
    expect(names).toContain('shared.pdf');
    expect(names).not.toContain('private.pdf');
    expect(names).not.toContain('unassigned.pdf');
  });

  it('skips the mail query entirely for another source', async () => {
    const files = await aggregateAllFiles(db, { userId: ASSIGNEE, source: 'drive' });
    expect(files.filter((f) => f.source === 'mail')).toEqual([]);
  });
});

describe('aggregateStats · mail counter', () => {
  it('counts what the feed would list, per caller', async () => {
    expect((await aggregateStats(db, MEMBER)).bySource.mail).toBe(1);
    expect((await aggregateStats(db, ASSIGNEE)).bySource.mail).toBe(2);
    expect((await aggregateStats(db, ADMIN)).bySource.mail).toBe(2);
  });

  it('keeps the total in step with the scoped counter', async () => {
    const member = await aggregateStats(db, MEMBER);
    const assignee = await aggregateStats(db, ASSIGNEE);
    expect(assignee.totalFiles - member.totalFiles).toBe(1);
  });
});

describe('normalizeGenericFiles · navigateTo', () => {
  function navigateTo(
    entityType: string,
    entityId: string,
    extra: { fileType?: string; metadata?: Record<string, unknown> } = {},
  ): string | null {
    const [file] = normalizeGenericFiles([
      {
        id: 'file_1',
        fileName: 'contract.pdf',
        fileType: extra.fileType ?? 'pdf',
        entityType,
        entityId,
        metadata: extra.metadata ?? null,
        createdAt: new Date(),
        updatedAt: null,
      } as unknown as typeof schema.files.$inferSelect,
    ]);
    return file!.navigateTo;
  }

  // CRM records have no detail routes; they open as object panels.
  it('opens a CRM company file in the company panel', () => {
    expect(navigateTo('crm_customer', 'cmp_acme')).toBe('/weldcrm/companies?stack=company:cmp_acme');
  });

  it('opens a CRM person file in the person panel', () => {
    expect(navigateTo('crm_contact', 'per_jane')).toBe('/weldcrm/people?stack=person:per_jane');
  });

  // Tickets have no route; `/welddesk/tickets/*` fell through to the inbox.
  it('opens a ticket file in the ticket sheet over the inbox', () => {
    expect(navigateTo('helpdesk_ticket', 'tkt_1')).toBe('/welddesk/inbox?entity=ticket:tkt_1');
  });

  // `/weldmail/inbox/:id` matched `/weldmail/$accountId/$labelSlug` instead.
  it('opens a mail attachment in the unified mailbox', () => {
    expect(navigateTo('mail_message', 'msg_1')).toBe('/weldmail/unified/inbox/msg_1');
  });

  it('opens a social post file in WeldSocial', () => {
    expect(navigateTo('social_post', 'post_1')).toBe('/social');
  });

  it('opens a project sheet in the sheet editor, other project files in Files', () => {
    expect(navigateTo('project', 'prj_1', { fileType: 'spreadsheet' })).toBe(
      '/weldflow/project/prj_1/table/file_1',
    );
    expect(navigateTo('project', 'prj_1')).toBe('/weldflow/project/prj_1/files');
  });

  it('opens a project document file in its project documents', () => {
    expect(navigateTo('project_document', 'doc_1', { metadata: { projectId: 'prj_1' } })).toBe(
      '/weldflow/project/prj_1/documents',
    );
  });

  it('opens a WeldSheets spreadsheet (a plain drive file) in its editor', () => {
    const [file] = normalizeGenericFiles([
      {
        id: 'file_1',
        fileName: 'Budget',
        fileType: 'spreadsheet',
        entityType: null,
        entityId: null,
        metadata: { weldsheetId: 'sht_1' },
        createdAt: new Date(),
        updatedAt: null,
      } as unknown as typeof schema.files.$inferSelect,
    ]);
    expect(file!.navigateTo).toBe('/weldsheets/sht_1');
    expect(isPlatformRoute(file!.navigateTo!)).toBe(true);
  });

  it('opens a WeldDocs document in its editor, not the BlockNote one', () => {
    const [file] = normalizeGenericFiles([
      {
        id: 'file_2',
        fileName: 'Plan',
        fileType: 'document',
        entityType: null,
        entityId: null,
        metadata: { weldDocId: 'doc_1' },
        createdAt: new Date(),
        updatedAt: null,
      } as unknown as typeof schema.files.$inferSelect,
    ]);
    expect(file!.navigateTo).toBe('/welddocs/doc_1');
    expect(file!.isWeldDoc).toBe(false);
    expect(isPlatformRoute(file!.navigateTo!)).toBe(true);
  });

  it.each([
    ['crm_customer', {}],
    ['crm_contact', {}],
    ['helpdesk_ticket', {}],
    ['mail_message', {}],
    ['social_post', {}],
    ['project', { fileType: 'spreadsheet' }],
    ['project', {}],
    ['project_document', { metadata: { projectId: 'prj_1' } }],
  ] as const)('links a %s file to a route the platform has', (entityType, extra) => {
    const url = navigateTo(entityType, 'x_1', extra);
    expect(url).not.toBeNull();
    expect(isPlatformRoute(url!)).toBe(true);
  });
});
