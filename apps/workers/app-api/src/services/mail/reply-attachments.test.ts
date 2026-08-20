/**
 * pglite-backed test: a reply can carry R2-uploaded attachments through
 * `replyAndPersist` the same way compose/forward do. The paperclip in the
 * inline reply box used to toast "Attach file" and never reached this path.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { replyAndPersist } from './send';
import { createPgliteDb } from '../../test/pglite';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Database } from '../../db';
import type { Env } from '../../types';

const { mailAccounts, mailMessages, mailAttachments } = schema;

const ORG = 'org_test';
const USER = 'user_test';
const SELF = 'me@test.dev';
const FILE_KEY = `workspaces/${ORG}/mail-attachments/note.txt`;
const FILE_BYTES = new TextEncoder().encode('hello');

const env = {
  STORAGE: {
    get: async (key: string) => {
      if (key !== FILE_KEY) return null;
      return {
        arrayBuffer: async () => FILE_BYTES.buffer,
        httpMetadata: { contentType: 'text/plain' },
      };
    },
  },
} as unknown as Env;

let db: Database;

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: SELF, isShared: true });
  return id;
}

async function seedIncoming(accountId: string): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: SELF }],
    subject: 'Please reply',
    sentDate: new Date(),
  });
  return id;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('replyAndPersist · attachments (pglite, dryRun)', () => {
  it('persists an uploaded attachment on the SENT reply', async () => {
    const accountId = await seedAccount();
    const original = await seedIncoming(accountId);

    const result = await replyAndPersist(
      env,
      db,
      ORG,
      USER,
      original,
      {
        body: 'See attached',
        attachments: [
          { filename: 'note.txt', contentType: 'text/plain', size: FILE_BYTES.byteLength, fileKey: FILE_KEY },
        ],
      },
      undefined,
      { dryRun: true },
    );

    const rows = await db
      .select({ fileName: mailAttachments.fileName, storagePath: mailAttachments.storagePath })
      .from(mailAttachments)
      .where(eq(mailAttachments.messageId, result.messageId));

    expect(rows).toEqual([{ fileName: 'note.txt', storagePath: FILE_KEY }]);
  });
});
