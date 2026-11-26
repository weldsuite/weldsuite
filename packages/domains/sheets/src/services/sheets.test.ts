/**
 * `adoptFileAsSheet`: the `files` update and the `sheets` insert commit as one
 * unit. These tests pin the invariant that buys: a `files` row never claims a
 * `weldsheetId` that was never written, and a convert that loses the race
 * leaves no `sheets` row behind.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { adoptFileAsSheet, getSheet } from './sheets';

const { files, sheets } = schema;

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(sheets);
  await db.delete(files);
});

/** An old WeldFlow project sheet (.xlsx), not yet converted. */
async function oldFile(id: string): Promise<void> {
  await db.insert(files).values({
    id,
    fileName: 'Tasks.xlsx',
    originalName: 'Tasks.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileSize: 100,
    fileType: 'spreadsheet',
    storagePath: `old/${id}.xlsx`,
    fileKey: `old/${id}.xlsx`,
    uploadedById: 'alice',
  } as typeof files.$inferInsert);
}

describe('adoptFileAsSheet', () => {
  it('makes the file a spreadsheet, pointing at a sheets row that exists', async () => {
    await oldFile('fil_1');
    const sheet = await adoptFileAsSheet(db, {
      fileId: 'fil_1',
      sheetId: 'sht_1',
      workspaceId: 'org_test',
      name: 'Tasks',
      snapshotSize: 10,
      userId: 'alice',
      oldKey: 'old/fil_1.xlsx',
    });
    expect(sheet).toMatchObject({ id: 'sht_1', fileId: 'fil_1', name: 'Tasks' });
    const [file] = await db.select().from(files).where(eq(files.id, 'fil_1'));
    expect(file!.metadata).toMatchObject({ weldsheetId: 'sht_1', convertedFrom: { key: 'old/fil_1.xlsx' } });
    expect(file!.mimeType).toBe('application/vnd.weldsuite.spreadsheet');
  });

  it('a convert that lost the race writes nothing', async () => {
    await oldFile('fil_2');
    // Someone else's convert already landed on this file.
    const winner = await adoptFileAsSheet(db, {
      fileId: 'fil_2',
      sheetId: 'sht_winner',
      workspaceId: 'org_test',
      name: 'Tasks',
      snapshotSize: 10,
      userId: 'alice',
      oldKey: 'old/fil_2.xlsx',
    });
    expect(winner).not.toBeNull();

    // A second attempt racing on the same file, with its own sheetId, loses.
    const loser = await adoptFileAsSheet(db, {
      fileId: 'fil_2',
      sheetId: 'sht_loser',
      workspaceId: 'org_test',
      name: 'Tasks',
      snapshotSize: 10,
      userId: 'bob',
      oldKey: 'old/fil_2.xlsx',
    });
    expect(loser).toBeNull();

    // No sheets row for the loser, and the file was not repointed at it.
    expect(await getSheet(db, 'sht_loser')).toBeNull();
    const [row] = await db.select().from(sheets).where(eq(sheets.id, 'sht_loser'));
    expect(row).toBeUndefined();

    // The file still points at the winner, which still opens.
    const [file] = await db.select().from(files).where(eq(files.id, 'fil_2'));
    expect((file!.metadata as { weldsheetId: string }).weldsheetId).toBe('sht_winner');
    expect(await getSheet(db, 'sht_winner')).not.toBeNull();
  });

  it('rolls the file back when the sheet insert fails', async () => {
    await oldFile('fil_3');
    await oldFile('fil_other');
    // Make the insert fail: the sheet id is already taken.
    await db.insert(sheets).values({ id: 'sht_taken', fileId: 'fil_other' });

    await expect(
      adoptFileAsSheet(db, {
        fileId: 'fil_3',
        sheetId: 'sht_taken',
        workspaceId: 'org_test',
        name: 'Tasks',
        snapshotSize: 10,
        userId: 'alice',
        oldKey: 'old/fil_3.xlsx',
      }),
    ).rejects.toThrow();

    // The file is still the untouched .xlsx, so a retry can convert it.
    const [file] = await db.select().from(files).where(eq(files.id, 'fil_3'));
    expect((file!.metadata as { weldsheetId?: string } | null)?.weldsheetId).toBeUndefined();
    expect(file!.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});
