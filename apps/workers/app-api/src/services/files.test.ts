/**
 * pglite-backed service tests for `services/files.ts`. Exercises the
 * name-conflict + deduplication logic and the soft-delete contract
 * — those are pure-ish (no R2) and lend themselves to integration
 * testing without standing up a bucket.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createFile,
  getFile,
  softDeleteFile,
  toggleStar,
  hasFileNameConflict,
  deduplicateFileName,
} from './files';
import { createPgliteDb } from '../test/pglite';
import type { Database } from '../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const baseParams = (over: Record<string, unknown> = {}) => ({
  fileName: 'doc.pdf',
  mimeType: 'application/pdf',
  fileSize: 1024,
  storagePath: 'wkspc/abc/doc.pdf',
  uploadedById: 'user_test',
  ...over,
});

describe('files service · pglite integration', () => {
  it('createFile writes a row with the expected metadata', async () => {
    const f = await createFile(db, baseParams());
    expect(f.id).toMatch(/^fil_/);

    const fetched = await getFile(db, f.id);
    expect(fetched?.fileName).toBe('doc.pdf');
    expect(fetched?.uploadedById).toBe('user_test');
  });

  it('deduplicateFileName appends " (N)" before the extension on conflict', async () => {
    // Seed a conflicting file.
    await createFile(db, baseParams({ fileName: 'report.pdf' }));
    const dedupe1 = await deduplicateFileName(db, 'report.pdf', null);
    expect(dedupe1).toBe('report (1).pdf');
    await createFile(db, baseParams({ fileName: dedupe1 }));
    const dedupe2 = await deduplicateFileName(db, 'report.pdf', null);
    expect(dedupe2).toBe('report (2).pdf');
  });

  it('deduplicateFileName preserves names without an extension', async () => {
    await createFile(db, baseParams({ fileName: 'README' }));
    expect(await deduplicateFileName(db, 'README', null)).toBe('README (1)');
  });

  it('createFile auto-deduplicates when called with a conflicting name', async () => {
    await createFile(db, baseParams({ fileName: 'invoice.pdf' }));
    const second = await createFile(db, baseParams({ fileName: 'invoice.pdf' }));
    expect(second.fileName).toBe('invoice (1).pdf');
  });

  it('hasFileNameConflict respects the folderId scope', async () => {
    await createFile(db, baseParams({ fileName: 'in-root.pdf' }));
    // Same name in a different folder is NOT a conflict.
    expect(await hasFileNameConflict(db, 'in-root.pdf', 'folder_x')).toBe(false);
    expect(await hasFileNameConflict(db, 'in-root.pdf', null)).toBe(true);
  });

  it('softDeleteFile hides the row from getFile + hasFileNameConflict', async () => {
    const f = await createFile(db, baseParams({ fileName: 'gone.pdf' }));
    await softDeleteFile(db, f.id);
    expect(await getFile(db, f.id)).toBeNull();
    // Once deleted, a new file can take the original name without
    // collision.
    expect(await hasFileNameConflict(db, 'gone.pdf', null)).toBe(false);
  });

  it('toggleStar flips the isStarred flag', async () => {
    const f = await createFile(db, baseParams({ fileName: 'star-me.pdf' }));
    const before = await getFile(db, f.id);
    expect(before?.isStarred).toBe(false);

    await toggleStar(db, f.id);
    const after = await getFile(db, f.id);
    expect(after?.isStarred).toBe(true);

    await toggleStar(db, f.id);
    const back = await getFile(db, f.id);
    expect(back?.isStarred).toBe(false);
  });
});
