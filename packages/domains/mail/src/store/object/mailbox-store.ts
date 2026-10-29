/**
 * `ObjectMailboxStore`: the mailbox object's implementation of `MailboxStore`
 * (design task C2, §2.1) — a thin RPC client over one mailbox's Durable
 * Object (`./stub`), plus the two things the object itself never does:
 *
 * - **Bodies.** The object never stores message text (`mailbox-object/reads.ts`'s
 *   own contract: "a caller wanting bodies reads R2 itself"). Every read that
 *   Postgres always/optionally returns bodies for — `getMessage(…,{bodies})`,
 *   `getThread`, `getThreadOfMessage`, `listScheduled`, `exportPage`, and any
 *   write whose `OpResult.message` is set — gets them merged in here from R2
 *   (`../bodies`), so a caller sees the same shape regardless of backend.
 * - **Ingest bodies out of the RPC payload.** `IngestMessage.content` is
 *   "worker-side only; never sent over RPC" (`../types`) — for the object
 *   backend specifically, because the object stores bodies in R2, not SQLite.
 *   `apply`/`applyBatch` intercept every `ingest` op, put `content.html`/
 *   `content.text` to R2 first, set `bodies` presence bits and a derived
 *   `searchText` (only when the caller didn't already supply one), and strip
 *   `content` before forwarding to the stub (design §2.1, bullet on this
 *   file).
 */

import { getMessageBodies, putMessageBodies, type MailBodyRef } from '../bodies';
import { plainTextBody } from '../../text';
import {
  mailboxStubFor,
  callStubRead,
  callStubWrite,
  isBatchRetryable,
  isRetryableOp,
  type MailboxStoreNamespaceEnv,
  type MailboxStoreRpc,
} from './stub';
import { mapWithConcurrency } from './concurrency';
import type {
  FolderKey,
  IngestMessage,
  InboundThreadQuery,
  LabelCount,
  MailAttachmentRecord,
  MailboxOp,
  MailboxRef,
  MailboxStats,
  MailboxStore,
  MailMessageListRow,
  MailMessageRecord,
  MessageListQuery,
  MessagePage,
  OpResult,
  SnoozedMessage,
  ThreadListQuery,
  ThreadPage,
} from '../types';

/** Bodies up to this many messages are fetched in parallel per call (`getThread`'s live-message cap is 1000, design §3.3 — no reason to open 1000 R2 subrequests at once for one thread view). */
const BODY_FETCH_CONCURRENCY = 10;

/** `IngestMessage.searchText`'s documented cap ("≤ 8 KB plain text for FTS", `../types`). */
const MAX_SEARCH_TEXT_BYTES = 8192;

export interface ObjectMailboxStoreEnv extends MailboxStoreNamespaceEnv {
  /** The EU-jurisdiction mail body bucket (decision 7): `weldsuite-mail`/`weldsuite-mail-test`, bound `MAIL_STORAGE`. Not the older, non-EU-pinned `STORAGE` bucket `store/bodies.ts`'s own header comment still names — that comment predates decision 7. */
  MAIL_STORAGE: R2Bucket;
}

/** Byte-safe truncation: cuts at `maxBytes`, backing off out of a partial multi-byte UTF-8 sequence rather than corrupting it. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(encoded.subarray(0, end));
}

/** `IngestMessage.searchText` if the caller already set it; otherwise a plain-text extract of `content`, capped at 8 KB. `undefined` when there is nothing to search on. */
function resolveSearchText(message: IngestMessage): string | undefined {
  if (message.searchText !== undefined) return message.searchText;
  const plain = plainTextBody(message.content?.text ?? undefined, message.content?.html ?? undefined);
  return plain ? truncateUtf8(plain, MAX_SEARCH_TEXT_BYTES) : undefined;
}

export class ObjectMailboxStore implements MailboxStore {
  readonly backend = 'object' as const;
  private readonly stub: MailboxStoreRpc;

  constructor(
    private readonly env: ObjectMailboxStoreEnv,
    readonly ref: MailboxRef,
  ) {
    // NOT a field initializer: those run before parameter-property
    // assignments populate `this.env`/`this.ref` (class fields are
    // initialized at the top of the constructor, in declaration order,
    // ahead of the parameter-property assignments TypeScript compiles into
    // the constructor body) — `mailboxStubFor(this.env, this.ref)` would see
    // both as `undefined`. Assigning here, after they exist, avoids that.
    this.stub = mailboxStubFor(env, ref);
  }

  // -------------------------------------------------------------------
  // Bodies (private helpers)
  // -------------------------------------------------------------------

  private bodyRef(messageId: string): MailBodyRef {
    return { workspaceId: this.ref.workspaceId, accountId: this.ref.accountId, messageId };
  }

  private async withBodies<T extends MailMessageRecord>(record: T): Promise<T> {
    const bodies = await getMessageBodies(this.env.MAIL_STORAGE, this.bodyRef(record.id));
    return { ...record, textBody: bodies.text, htmlBody: bodies.html };
  }

  private async withBodiesMany<T extends MailMessageRecord>(records: T[]): Promise<T[]> {
    if (records.length === 0) return records;
    return mapWithConcurrency(records, BODY_FETCH_CONCURRENCY, (record) => this.withBodies(record));
  }

  private async withBodiesInResult(result: OpResult): Promise<OpResult> {
    if (!result.message) return result;
    return { ...result, message: await this.withBodies(result.message) };
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  listThreads(q: ThreadListQuery): Promise<ThreadPage> {
    return callStubRead(() => this.stub.listThreads(this.ref, q));
  }

  async getThread(threadKey: string) {
    const result = await callStubRead(() => this.stub.getThread(this.ref, threadKey));
    if (!result) return null;
    return { ...result, messages: await this.withBodiesMany(result.messages) };
  }

  async getThreadOfMessage(messageId: string) {
    const result = await callStubRead(() => this.stub.getThreadOfMessage(this.ref, messageId));
    if (!result) return null;
    return { ...result, messages: await this.withBodiesMany(result.messages) };
  }

  async getMessage(id: string, o?: { bodies?: boolean; attachments?: boolean }) {
    const record = await callStubRead(() => this.stub.getMessage(this.ref, id, o));
    if (!record) return null;
    return o?.bodies ? await this.withBodies(record) : record;
  }

  getMessages(ids: string[], opts?: { includeDeleted?: boolean }): Promise<MailMessageListRow[]> {
    return callStubRead(() => this.stub.getMessages(this.ref, ids, opts));
  }

  listMessages(q: MessageListQuery): Promise<MessagePage> {
    return callStubRead(() => this.stub.listMessages(this.ref, q));
  }

  stats(): Promise<MailboxStats> {
    return callStubRead(() => this.stub.stats(this.ref));
  }

  unreadCount(scope: 'inbox' | 'all-live'): Promise<number> {
    return callStubRead(() => this.stub.unreadCount(this.ref, scope));
  }

  labelCounts(keys: FolderKey[]): Promise<Record<FolderKey, LabelCount>> {
    return callStubRead(() => this.stub.labelCounts(this.ref, keys));
  }

  listAttachments(messageId: string): Promise<MailAttachmentRecord[]> {
    return callStubRead(() => this.stub.listAttachments(this.ref, messageId));
  }

  getAttachment(id: string): Promise<(MailAttachmentRecord & { accountId: string }) | null> {
    return callStubRead(() => this.stub.getAttachment(this.ref, id));
  }

  recentAttachments(q: { before?: { createdAt: number; id: string }; limit: number }) {
    return callStubRead(() => this.stub.recentAttachments(this.ref, q));
  }

  recentAddresses(limit: number): Promise<string[]> {
    return callStubRead(() => this.stub.recentAddresses(this.ref, limit));
  }

  resolveInbound(q: InboundThreadQuery) {
    return callStubRead(() => this.stub.resolveInbound(this.ref, q));
  }

  findByRfcIds(ids: string[], providerIds: string[]) {
    return callStubRead(() => this.stub.findByRfcIds(this.ref, ids, providerIds));
  }

  findSentByIdempotencyKey(key: string) {
    return callStubRead(() => this.stub.findSentByIdempotencyKey(this.ref, key));
  }

  countSentSince(since: number): Promise<number> {
    return callStubRead(() => this.stub.countSentSince(this.ref, since));
  }

  async listScheduled(): Promise<MailMessageRecord[]> {
    const rows = await callStubRead(() => this.stub.listScheduled(this.ref));
    return this.withBodiesMany(rows);
  }

  listSnoozed(): Promise<SnoozedMessage[]> {
    return callStubRead(() => this.stub.listSnoozed(this.ref));
  }

  listSubscriptions(q: { status?: 'active' | 'unsubscribed' }) {
    return callStubRead(() => this.stub.listSubscriptions(this.ref, q));
  }

  getSubscription(id: string) {
    return callStubRead(() => this.stub.getSubscription(this.ref, id));
  }

  rawSources(q: { since: number; limit: number }) {
    return callStubRead(() => this.stub.rawSources(this.ref, q));
  }

  listDrafts(q: { limit: number; cursor?: string }) {
    return callStubRead(() => this.stub.listDrafts(this.ref, q));
  }

  getDraft(id: string) {
    return callStubRead(() => this.stub.getDraft(this.ref, id));
  }

  async exportPage(q: { cursor?: string; limit: number; sentOnly?: boolean; since?: number; until?: number }) {
    const page = await callStubRead(() => this.stub.exportPage(this.ref, q));
    return { ...page, data: await this.withBodiesMany(page.data) };
  }

  // -------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------

  async apply(op: MailboxOp, at?: number): Promise<OpResult> {
    const prepared = await this.prepareOp(op);
    const result = await callStubWrite(() => this.stub.apply(this.ref, prepared, at), isRetryableOp(prepared));
    return this.withBodiesInResult(result);
  }

  async applyBatch(ops: MailboxOp[], at?: number): Promise<OpResult[]> {
    const prepared = await Promise.all(ops.map((op) => this.prepareOp(op)));
    const results = await callStubWrite(() => this.stub.applyBatch(this.ref, prepared, at), isBatchRetryable(prepared));
    return Promise.all(results.map((r) => this.withBodiesInResult(r)));
  }

  /** Intercepts `ingest` to move `content` into R2 before the RPC (this file's header comment); every other op passes through unchanged. */
  private async prepareOp(op: MailboxOp): Promise<MailboxOp> {
    if (op.kind !== 'ingest') return op;
    return { kind: 'ingest', message: await this.prepareIngestMessage(op.message) };
  }

  private async prepareIngestMessage(message: IngestMessage): Promise<IngestMessage> {
    const { content, ...withoutContent } = message;
    const searchText = resolveSearchText(message);
    if (!content || (content.html == null && content.text == null)) {
      return { ...withoutContent, searchText };
    }
    await putMessageBodies(this.env.MAIL_STORAGE, this.bodyRef(message.id), content);
    return {
      ...withoutContent,
      bodies: { html: content.html != null, text: content.text != null, raw: message.bodies?.raw ?? false },
      searchText,
    };
  }
}
