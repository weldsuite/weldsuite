/**
 * POST /api/attachments/upload on pglite: a visitor's file goes into the
 * `STORAGE` bucket under `widgets/<clerk org id>/<conversation id>/…`, tied to
 * a conversation the visitor owns (the visitor its visitor token names), and
 * the answer carries the public URL a
 * message can then point at. Only passive file types up to 10 MB are taken:
 * the bucket is served from a public domain, so a stored SVG or HTML file would
 * run script on it.
 *
 * Conformance-ready: the bucket is an R2-shaped memory bucket the harness
 * shares with the Rust backend, which reads and writes the same objects. The
 * upload also publishes a `helpdesk_attachment:created` event to the realtime
 * workspace channel, which the harness compares.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import {
  FILES_ORIGIN,
  ORG,
  WIDGET,
  addWidget,
  at,
  bearer,
  json,
  seedWorkspaces,
  visitorRow,
  visitorToken,
  widgetEnv,
  widgetHeaders,
} from '../test/widget-fixtures';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  getWorkspaceForOrg: async () => ({ id: 'ws_acme' }),
}));

import worker from '../index';

const { deskConversations, deskMessages, deskVisitors } = tenantSchema;

const UPLOAD = '/api/attachments/upload';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const CONVERSATION = 'dconv_up';
const VISITOR = 'vis_up';

let tenantDb: Database;
let masterDb: Database;
// One bucket for the whole file: the harness serves each bucket to Rust once.
const storage = createMemoryR2();

function app(env: Record<string, unknown> = {}) {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv({ STORAGE: storage, ...env }),
    rustBasePath: '/public/helpdesk-widget',
  });
}

interface UploadFields {
  /** A file, a plain field instead of one (`string`), or none (`null`). */
  file?: File | string | null;
  conversationId?: string | null;
  /** A `visitorId` field, as the widget sent before visitor tokens: the route ignores it. */
  visitorId?: string;
}

interface UploadOptions {
  widgetId?: string;
  workspaceId?: string;
  env?: Record<string, unknown>;
  /** Whose visitor token the upload carries (default the owner's); `null` for none. */
  as?: string | null;
}

/** A multipart upload as the widget sends it; fields default to the owner's, `null` leaves one out. */
async function upload(fields: UploadFields = {}, options: UploadOptions = {}) {
  const form = new FormData();
  const file = fields.file === undefined ? new File(['hello'], 'hello.txt', { type: 'text/plain' }) : fields.file;
  if (typeof file === 'string') form.append('file', file);
  else if (file !== null) form.append('file', file);
  const conversationId = fields.conversationId === undefined ? CONVERSATION : fields.conversationId;
  if (conversationId !== null) form.append('conversationId', conversationId);
  if (fields.visitorId !== undefined) form.append('visitorId', fields.visitorId);
  const widgetId = options.widgetId ?? WIDGET;
  const visitor = options.as === undefined ? VISITOR : options.as;
  const token =
    visitor === null ? null : await visitorToken(visitor, { widgetId, workspaceId: options.workspaceId });
  return app(options.env).request(UPLOAD, {
    method: 'POST',
    headers: widgetHeaders(widgetId, token === null ? {} : bearer(token)),
    body: form,
  });
}

const png = (name = 'pic.png', size = 64) => new File([new Uint8Array(size).fill(1)], name, { type: 'image/png' });

const internal = (message: string) => ({ success: false, error: { code: 'INTERNAL_ERROR', message } });
const badRequest = (message: string) => ({ success: false, error: { code: 'BAD_REQUEST', message } });

async function keysInBucket(): Promise<string[]> {
  const listed = await storage.list({ prefix: 'widgets/' });
  return listed.objects.map((o) => o.key).sort();
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET);
  await addWidget(masterDb, tenantDb, 'wdg_white', { workspaceId: 'ws_white' });

  const conversation = (id: string, number: number, visitorId: string, values: Partial<typeof deskConversations.$inferInsert> = {}) =>
    tenantDb.insert(deskConversations).values({
      id,
      conversationNumber: number,
      visitorId,
      title: id,
      state: 'open',
      channel: 'messenger',
      // The team is already waiting, so a message into it tells nobody.
      waitingSince: at(1),
      createdAt: at(0),
      updatedAt: at(0),
      lastMessageAt: at(1),
      ...values,
    });
  await conversation(CONVERSATION, 1, VISITOR);
  await conversation('dconv_up_other', 2, 'vis_other');
  await tenantDb.insert(deskVisitors).values([visitorRow(VISITOR), visitorRow('vis_other')]);
}, 120_000);

describe('POST /api/attachments/upload', () => {
  it('stores the file in the bucket under the workspace and conversation, and answers its public URL', async () => {
    const bytes = new Uint8Array(2048).map((_, i) => i % 251);
    const res = await upload({ file: new File([bytes], 'Screen shot.png', { type: 'image/png' }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: true;
      data: { id: string; fileName: string; fileSize: number; mimeType: string; url: string; fileKey: string };
    };
    expect(body).toEqual({
      success: true,
      data: {
        id: expect.stringMatching(/^att_[0-9a-z]{12,}$/),
        fileName: 'Screen shot.png',
        fileSize: 2048,
        mimeType: 'image/png',
        url: expect.any(String),
        fileKey: expect.any(String),
      },
    });
    const { id, fileKey, url } = body.data;
    // widgets/<clerk org id>/<conversation id>/<Date.now()>_<attachment id>_<name with unsafe characters as _>
    expect(fileKey).toMatch(new RegExp(`^widgets/${ORG}/${CONVERSATION}/\\d{13}_${id}_Screen_shot\\.png$`));
    // The public base URL has no trailing slash to double.
    expect(url).toBe(`${FILES_ORIGIN}/${fileKey}`);

    const stored = await storage.get(fileKey);
    expect(stored).not.toBeNull();
    expect(stored!.httpMetadata?.contentType).toBe('image/png');
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });

  it('replaces every character outside letters, digits, dot, dash and underscore in the stored name', async () => {
    const res = await upload({ file: new File(['%PDF'], 'résumé (final) v2.pdf', { type: 'application/pdf' }) });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { fileName: string; fileKey: string } };
    expect(data.fileName).toBe('résumé (final) v2.pdf');
    expect(data.fileKey).toMatch(/\/\d{13}_att_[0-9a-z]+_r_sum___final__v2\.pdf$/);
    expect(await storage.head(data.fileKey)).not.toBeNull();
  });

  it('keys the object by the Clerk org of the widget’s workspace', async () => {
    const res = await upload({ file: png('other.png') }, { widgetId: 'wdg_white', workspaceId: 'ws_white' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { fileKey: string; url: string } };
    expect(data.fileKey).toMatch(new RegExp(`^widgets/org_white/${CONVERSATION}/\\d{13}_att_[0-9a-z]+_other\\.png$`));
    expect(data.url).toBe(`${FILES_ORIGIN}/${data.fileKey}`);
  });

  it('takes each of the allowed file types', async () => {
    const types = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    for (const type of types) {
      const res = await upload({ file: new File(['x'], 'file.bin', { type }) });
      expect(res.status, type).toBe(201);
      const { data } = (await res.json()) as { data: { mimeType: string; fileKey: string } };
      expect(data.mimeType, type).toBe(type);
      expect((await storage.head(data.fileKey))?.httpMetadata?.contentType, type).toBe(type);
    }
  });

  it('takes a file of exactly 10 MB', async () => {
    const res = await upload({ file: new File([new Uint8Array(MAX_FILE_SIZE)], 'big.pdf', { type: 'application/pdf' }) });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { fileSize: number; fileKey: string } };
    expect(data.fileSize).toBe(MAX_FILE_SIZE);
    expect((await storage.head(data.fileKey))?.size).toBe(MAX_FILE_SIZE);
  });

  it('lets a message point at the file it was just given', async () => {
    const up = await upload({ file: png('proof.png', 300) });
    const { data } = (await up.json()) as { data: { url: string; fileName: string; fileSize: number; mimeType: string } };
    const res = await app().request(
      `/api/conversations/${CONVERSATION}/messages`,
      json(
        { attachments: [{ name: data.fileName, url: data.url, contentType: data.mimeType, filesize: data.fileSize }] },
        { token: await visitorToken(VISITOR) },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { message: { id: string; attachments: unknown[] } } };
    expect(body.data.message.attachments).toEqual([
      { name: 'proof.png', url: data.url, contentType: 'image/png', filesize: 300 },
    ]);
    const [row] = await tenantDb.select().from(deskMessages).where(eq(deskMessages.id, body.data.message.id));
    expect(row.attachments).toEqual(body.data.message.attachments);
  });
});

describe('POST /api/attachments/upload: refusals', () => {
  it('is a 500 when the worker has no public bucket URL, even for a blank one', async () => {
    for (const R2_PUBLIC_URL of [undefined, '   ']) {
      const res = await upload({ file: png() }, { env: { R2_PUBLIC_URL } });
      expect(res.status, String(R2_PUBLIC_URL)).toBe(500);
      expect(await res.json(), String(R2_PUBLIC_URL)).toEqual(internal('File upload not available'));
    }
  });

  it('is a 500 when the worker has no bucket', async () => {
    const res = await upload({ file: png() }, { env: { STORAGE: undefined } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(internal('File upload not available'));
  });

  it('needs a file', async () => {
    for (const file of [null, 'not a file']) {
      const res = await upload({ file });
      expect(res.status, String(file)).toBe(400);
      expect(await res.json(), String(file)).toEqual(badRequest('No file provided'));
    }
  });

  it('needs a conversation id made of letters, digits, dash and underscore, up to 64 characters', async () => {
    for (const conversationId of [null, '', 'has space', '../dconv_up', 'dconv/up', 'a'.repeat(65)]) {
      const res = await upload({ file: png(), conversationId });
      expect(res.status, String(conversationId)).toBe(400);
      expect(await res.json(), String(conversationId)).toEqual(badRequest('conversationId is required'));
    }
  });

  it('needs a visitor token, before the form is read', async () => {
    for (const fields of [{ file: png() }, { file: null, conversationId: null }, { file: png(), visitorId: VISITOR }]) {
      const res = await upload(fields, { as: null });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'VISITOR_TOKEN_REQUIRED', message: 'Missing visitor token' },
      });
    }
  });

  it('asks for the file first, then the conversation', async () => {
    const noFile = await upload({ file: null, conversationId: null });
    expect(await noFile.json()).toEqual(badRequest('No file provided'));
    const noConversation = await upload({ file: png(), conversationId: null });
    expect(await noConversation.json()).toEqual(badRequest('conversationId is required'));
  });

  it('is a 404 for another visitor’s conversation, and for one that does not exist, whatever the file', async () => {
    const hugeSvg = new File([new Uint8Array(MAX_FILE_SIZE + 1)], 'huge.svg', { type: 'image/svg+xml' });
    for (const [conversationId, visitorId] of [
      [CONVERSATION, 'vis_other'],
      ['dconv_up_other', VISITOR],
      ['dconv_nowhere', VISITOR],
    ] as const) {
      // The owner's id in the form counts for nothing: the visitor is the token's.
      const res = await upload({ file: hugeSvg, conversationId, visitorId: VISITOR }, { as: visitorId });
      expect(res.status, `${conversationId} ${visitorId}`).toBe(404);
      expect(await res.json(), `${conversationId} ${visitorId}`).toEqual({
        success: false,
        error: { code: 'NOT_FOUND', message: `Conversation with ID '${conversationId}' not found` },
      });
    }
  });

  it('refuses a file over 10 MB, before looking at its type', async () => {
    const big = new File([new Uint8Array(MAX_FILE_SIZE + 1)], 'big.png', { type: 'image/png' });
    const res = await upload({ file: big });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(badRequest('File too large (max 10MB)'));

    const bigSvg = new File([new Uint8Array(MAX_FILE_SIZE + 1)], 'big.svg', { type: 'image/svg+xml' });
    const both = await upload({ file: bigSvg });
    expect(await both.json()).toEqual(badRequest('File too large (max 10MB)'));
  });

  it('refuses a type that can carry script, or any type not on the list', async () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/javascript', 'application/zip', 'application/octet-stream']) {
      const res = await upload({ file: new File(['x'], 'file.bin', { type }) });
      expect(res.status, type).toBe(400);
      expect(await res.json(), type).toEqual(badRequest(`File type not allowed: ${type}`));
    }
  });

  it('stores nothing for a refused upload', async () => {
    // Only what the accepted uploads above wrote: 1 + 1 + 1 + 10 + 1 + 1 objects.
    const keys = await keysInBucket();
    expect(keys).toHaveLength(15);
    for (const key of keys) {
      expect(key).toMatch(new RegExp(`^widgets/org_(acme|white)/${CONVERSATION}/`));
    }
    // And nothing under the other conversations.
    expect(keys.filter((k) => k.includes('dconv_up_other') || k.includes('dconv_nowhere'))).toEqual([]);
    const messages = await tenantDb
      .select({ id: deskMessages.id })
      .from(deskMessages)
      .where(eq(deskMessages.conversationId, 'dconv_up_other'));
    expect(messages).toEqual([]);
  });
});
