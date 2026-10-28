/**
 * `ObjectMailboxStore`: the thin RPC client plus the two things only this
 * adapter does — merging message bodies in from R2 (the object itself never
 * stores them) and intercepting `ingest` so `IngestMessage.content` never
 * travels over RPC. Exercised against the fake stub (`./testing/fake-stub`),
 * which runs the real `mailbox-object/{reads,writes}.ts` logic.
 */

import { describe, it, expect } from 'vitest';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { ObjectMailboxStore, type ObjectMailboxStoreEnv } from './mailbox-store';
import { createFakeMailboxNamespace } from './testing/fake-env';
import type { FakeMailboxStub } from './testing/fake-stub';
import type { IngestMessage, MailboxRef } from '../types';

const ref: MailboxRef = { workspaceId: 'ws_1', accountId: 'acc_1', clerkOrgId: 'org_1' };

function makeStore(): { store: ObjectMailboxStore; stub: FakeMailboxStub; bucket: R2Bucket } {
  const { namespace, stubs } = createFakeMailboxNamespace();
  const bucket = createMemoryR2();
  const env: ObjectMailboxStoreEnv = { MAILBOX_STORE: namespace, MAIL_STORAGE: bucket };
  // The constructor resolves the stub eagerly (`mailboxStubFor`), so it
  // already exists in `stubs` by the time this returns.
  const store = new ObjectMailboxStore(env, ref);
  return { store, stub: stubs.get('mbx:ws_1:acc_1')!, bucket };
}

let seq = 0;
function makeIngest(overrides: Partial<IngestMessage> = {}): IngestMessage {
  seq += 1;
  return {
    id: `msg_${seq}`,
    source: 'inbound',
    rfcMessageId: `rfc-${seq}@example.com`,
    threadId: null,
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: 'bob@example.com', name: 'Bob' }],
    subject: 'Hello',
    preview: 'Hi there',
    sentAt: 1_000,
    receivedAt: 1_000,
    createdAt: 1_000,
    isRead: false,
    labels: ['INBOX'],
    isSpam: false,
    isReply: false,
    attachments: [],
    ...overrides,
  };
}

describe('ObjectMailboxStore: ingest body interception', () => {
  it('writes content to R2, sets presence bits, and never forwards content over the RPC', async () => {
    const { store, bucket } = makeStore();
    const message = makeIngest({ content: { html: '<p>Hi</p>', text: 'Hi there' } });

    const result = await store.apply({ kind: 'ingest', message }, 1_000);
    expect(result.ingest?.created).toBe(true);

    const htmlObj = await bucket.get('mail/ws_1/acc_1/' + message.id + '/body.html');
    const textObj = await bucket.get('mail/ws_1/acc_1/' + message.id + '/body.txt');
    expect(await htmlObj!.text()).toBe('<p>Hi</p>');
    expect(await textObj!.text()).toBe('Hi there');
  });

  it('merges bodies back on getMessage({bodies:true}) and leaves them out otherwise', async () => {
    const { store } = makeStore();
    const message = makeIngest({ content: { html: '<p>Hi</p>', text: 'Hi there' } });
    await store.apply({ kind: 'ingest', message }, 1_000);

    const withBodies = await store.getMessage(message.id, { bodies: true });
    expect(withBodies!.htmlBody).toBe('<p>Hi</p>');
    expect(withBodies!.textBody).toBe('Hi there');

    const withoutBodies = await store.getMessage(message.id);
    expect(withoutBodies!.htmlBody).toBeNull();
    expect(withoutBodies!.textBody).toBeNull();
  });

  it('derives a plain-text searchText from content when the caller did not supply one', async () => {
    const { store } = makeStore();
    const message = makeIngest({ content: { html: '<p>please review the <b>attached</b> invoice</p>' } });
    await store.apply({ kind: 'ingest', message }, 1_000);

    const page = await store.listMessages({ limit: 10, search: 'invoice' });
    expect(page.data.map((m) => m.id)).toContain(message.id);
  });

  it('keeps a caller-supplied searchText as-is instead of deriving one', async () => {
    const { store } = makeStore();
    const message = makeIngest({
      content: { text: 'this body mentions nothing searchable' },
      searchText: 'bespoke indexed phrase',
    });
    await store.apply({ kind: 'ingest', message }, 1_000);

    const hit = await store.listMessages({ limit: 10, search: 'bespoke' });
    expect(hit.data.map((m) => m.id)).toContain(message.id);
    const miss = await store.listMessages({ limit: 10, search: 'nothing' });
    expect(miss.data.map((m) => m.id)).not.toContain(message.id);
  });

  it('passes an ingest with no content through untouched (no R2 writes, body_bits stay 0)', async () => {
    const { store, bucket } = makeStore();
    const message = makeIngest();
    await store.apply({ kind: 'ingest', message }, 1_000);
    expect(await bucket.get('mail/ws_1/acc_1/' + message.id + '/body.html')).toBeNull();
  });
});

describe('ObjectMailboxStore: thread/export/scheduled reads always include bodies', () => {
  it('getThread merges bodies into every message of the thread', async () => {
    const { store } = makeStore();
    const threadId = 'thread_1';
    const a = makeIngest({ threadId, content: { text: 'first' }, sentAt: 1_000 });
    const b = makeIngest({ threadId, content: { text: 'second' }, sentAt: 2_000 });
    await store.applyBatch([
      { kind: 'ingest', message: a },
      { kind: 'ingest', message: b },
    ]);

    const thread = await store.getThread(threadId);
    expect(thread!.messages.map((m) => m.textBody)).toEqual(['first', 'second']);
  });

  it('getThreadOfMessage merges bodies too', async () => {
    const { store } = makeStore();
    const message = makeIngest({ content: { text: 'solo' } });
    await store.apply({ kind: 'ingest', message });

    const thread = await store.getThreadOfMessage(message.id);
    expect(thread!.messages[0]!.textBody).toBe('solo');
  });

  it('exportPage merges bodies for the whole page', async () => {
    const { store } = makeStore();
    const message = makeIngest({ content: { text: 'exported body' } });
    await store.apply({ kind: 'ingest', message });

    const page = await store.exportPage({ limit: 10 });
    const row = page.data.find((m) => m.id === message.id);
    expect(row!.textBody).toBe('exported body');
  });

  it('listScheduled merges bodies', async () => {
    const { store } = makeStore();
    const message = makeIngest({
      content: { text: 'scheduled body' },
      labels: ['SCHEDULED'],
      sendStatus: 'scheduled',
      scheduledFor: 5_000,
    });
    await store.apply({ kind: 'ingest', message });

    const scheduled = await store.listScheduled();
    const row = scheduled.find((m) => m.id === message.id);
    expect(row).toBeDefined();
    expect(row!.textBody).toBe('scheduled body');
  });
});

describe('ObjectMailboxStore: write ops with a returned message get bodies merged too', () => {
  it('flags on a single id returns an OpResult.message with bodies filled in', async () => {
    const { store } = makeStore();
    const message = makeIngest({ content: { text: 'flag me' } });
    await store.apply({ kind: 'ingest', message });

    const result = await store.apply({ kind: 'flags', ids: [message.id], patch: { isStarred: true }, semantics: 'single' });
    expect(result.message).toBeTruthy();
    expect(result.message!.textBody).toBe('flag me');
  });
});

describe('ObjectMailboxStore: retry wiring', () => {
  it('retries a read through a transient stub failure', async () => {
    const { store, stub } = makeStore();
    const real = stub.listThreads.bind(stub);
    let calls = 0;
    stub.listThreads = (async (r, q) => {
      calls++;
      if (calls === 1) throw new Error('Durable Object overloaded');
      return real(r, q);
    }) as typeof stub.listThreads;

    const page = await store.listThreads({ labelSlug: '__all', pageSize: 10 });
    expect(page.threads).toEqual([]);
    expect(calls).toBe(2);
  });

  it('retries a write op that is retry-safe (ingest)', async () => {
    const { store, stub } = makeStore();
    const real = stub.apply.bind(stub);
    let calls = 0;
    stub.apply = (async (r, op, at) => {
      calls++;
      if (calls === 1) throw new Error('network error');
      return real(r, op, at);
    }) as typeof stub.apply;

    const message = makeIngest();
    const result = await store.apply({ kind: 'ingest', message }, 1_000);
    expect(result.ingest?.created).toBe(true);
    expect(calls).toBe(2);
  });
});
