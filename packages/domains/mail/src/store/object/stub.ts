/**
 * The worker-side handle on one mailbox's Durable Object: how to find it
 * (`mailboxStubFor`, the EU-jurisdiction lookup by name — decision 1 /
 * design §2's planned `mailboxStub`, renamed here per this task's brief) and
 * how to call it safely (the retry wrapper below).
 *
 * `MailboxStoreObject` (task C1, `mailbox-object/{mailbox-object,alarm,
 * outbox,destroy,index}.ts`) is being built in the same worktree, in
 * parallel, and does not exist here yet. Per this task's binding RPC
 * contract, once it exists it exposes every `MailboxStore` method (`../types`)
 * under the SAME name, parameters and return type, minus `ref`/`backend` —
 * called directly on the stub, with no `ref` argument, because the Durable
 * Object is already bound to exactly one mailbox by its own name
 * (`mailboxKeyFor`). `MailboxStoreRpc` is typed structurally off
 * `MailboxStore` instead of importing `DurableObjectStub<MailboxStoreObject>`
 * so this task isn't blocked on C1 landing first — see the two type aliases
 * below for the only edits needed once it does.
 */

import type { MailboxOp, MailboxRef, MailboxStore } from '../types';

// ---------------------------------------------------------------------------
// The stub's RPC surface
// ---------------------------------------------------------------------------

/**
 * `MailboxStore` minus `ref`/`backend` (the two members an RPC method can't
 * have: `ref` is implicit in which object you called, `backend` is a client-
 * side label, never server state). Every method here returns a `Promise`,
 * matching both the interface's own declarations and how a real Durable
 * Object RPC stub behaves regardless of whether the method body is sync.
 *
 * SWAP POINT 1 of 2: once `mailbox-object/mailbox-object.ts` exports
 * `MailboxStoreObject`, change this alias to
 * `DurableObjectStub<MailboxStoreObject>` (imported from `../../mailbox-object`)
 * — every file in `store/object/` is written against `MailboxStoreRpc`, so
 * nothing else needs to change.
 */
export type MailboxStoreRpc = Omit<MailboxStore, 'ref' | 'backend'>;

/**
 * The namespace surface `mailboxStubFor` needs: `jurisdiction('eu')` then
 * `idFromName`/`get`, exactly like `mail-index/client.ts`'s `mailIndexFor`.
 * A real `DurableObjectNamespace<MailboxStoreObject>` satisfies this (it has
 * a strictly larger surface — `newUniqueId`, `idFromString`, `getByName`,
 * `getExisting`, none of which this lookup uses).
 *
 * SWAP POINT 2 of 2: once C1 lands, `MailboxStoreNamespaceEnv.MAILBOX_STORE`
 * can be re-typed as `DurableObjectNamespace<MailboxStoreObject>` and this
 * interface can be deleted — but there is no correctness reason to rush that;
 * the structural interface keeps working unchanged against the real binding.
 */
export interface MailboxStoreNamespace {
  jurisdiction(jurisdiction: 'eu'): {
    idFromName(name: string): unknown;
    get(id: unknown): MailboxStoreRpc;
  };
}

export interface MailboxStoreNamespaceEnv {
  MAILBOX_STORE?: MailboxStoreNamespace;
}

/** `mbx:<workspaces.id>:<accountId>` (decision 1). The only call site that should ever call `idFromName` for this namespace — mirrors `mail-index/client.ts`'s `mailIndexKeyFor`. */
export function mailboxKeyFor(ref: MailboxRef): string {
  return `mbx:${ref.workspaceId}:${ref.accountId}`;
}

/**
 * The mailbox's stub, always through the EU jurisdiction (decision 1,
 * ADR MAIL-009). Throws if `MAILBOX_STORE` isn't bound — by the time any
 * `object`/`object-only`/`shadow`-mode code reaches here, the binding is a
 * deploy-time prerequisite (design §8), not something to degrade gracefully
 * from.
 */
export function mailboxStubFor(env: MailboxStoreNamespaceEnv, ref: MailboxRef): MailboxStoreRpc {
  if (!env.MAILBOX_STORE) {
    throw new Error('mailboxStubFor: MAILBOX_STORE binding is not configured');
  }
  const eu = env.MAILBOX_STORE.jurisdiction('eu');
  return eu.get(eu.idFromName(mailboxKeyFor(ref)));
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface StubRetryOptions {
  /** Total attempts including the first. Default 3 (one original call, two retries). */
  attempts?: number;
  /** Base delay before the first retry; doubles each subsequent attempt. Default 25ms. */
  baseDelayMs?: number;
}

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 25;

/**
 * Transient-failure heuristics for Workers RPC: an overloaded Durable Object,
 * a dropped connection, or the object's isolate being evicted mid-call all
 * surface as a plain `Error` with no stable `.code`, only a message workerd
 * controls. Matched case-insensitively against both `name` and `message`, and
 * kept conservative (false negatives just mean "don't retry a case that might
 * have been safe to retry" — never the other way round).
 */
const TRANSIENT_ERROR_PATTERN =
  /overloaded|exceeded|network|timed? ?out|reset|unavailable|temporarily|disconnected|internal error|fetch failed|econnreset/i;

export function isTransientStubError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return TRANSIENT_ERROR_PATTERN.test(`${err.name} ${err.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries `fn` on a transient error, up to `opts.attempts` total tries with exponential backoff. Any non-transient error, or the last attempt's error, is rethrown immediately. */
async function withStubRetry<T>(fn: () => Promise<T>, opts: StubRetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1 || !isTransientStubError(err)) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  // Unreachable (the loop above always returns or throws), but keeps the
  // function's return type honest without a non-null assertion.
  throw lastErr;
}

/** Every read is retry-safe: none of them mutate anything, so repeating one after a transient failure can never double-apply a write. */
export function callStubRead<T>(fn: () => Promise<T>, opts?: StubRetryOptions): Promise<T> {
  return withStubRetry(fn, opts);
}

/**
 * Retries a write ONLY when `retryable` is true — the caller (`ObjectMailboxStore`)
 * decides that per op via `isRetryableOp`/`isBatchRetryable` below. When
 * `retryable` is false, `fn` runs exactly once: a transient error after the
 * object may already have applied the write is left for the router's drift
 * repair (design §2.2), not masked by a blind retry.
 */
export function callStubWrite<T>(fn: () => Promise<T>, retryable: boolean, opts?: StubRetryOptions): Promise<T> {
  return retryable ? withStubRetry(fn, opts) : fn();
}

// ---------------------------------------------------------------------------
// Which ops are safe to replay
// ---------------------------------------------------------------------------

/**
 * Whether replaying `op` against the object with the same `(ref, op, at)` is
 * safe after a transient failure whose outcome is unknown (the write may
 * already have applied server-side before the error surfaced). Every
 * `MailboxOp` kind below is confirmed safe, for one of two reasons:
 *
 * - **Insert-if-absent by a caller-chosen id.** `ingest` is documented as
 *   such in the design (§2.2: "`ingest` is insert-if-absent. On replay it
 *   returns `created:false`"); `attachment.create`/`draft.create` are the
 *   same shape and are marked so in the object's own source
 *   (`mailbox-object/writes-extra.ts`: "idempotent replay, like `ingest`",
 *   `applyAttachmentCreate`/`applyDraftCreate`).
 * - **A per-field last-write-wins "set to an absolute value" patch**, never
 *   a relative delta (an increment or toggle), protected by the object's
 *   clock columns (design §3.2 `changeMessage`: "`at < clk ⇒ stale`" — note
 *   `at == clk` is NOT stale, so replaying with the identical `at` reapplies
 *   the identical patch rather than being skipped or duplicated; replaying
 *   with a *later* `at`, which is what happens if the caller doesn't pin
 *   `at` across retries, only ever moves affected clocks further forward,
 *   it never changes which value ends up stored). Every op below either
 *   goes through that same `changeMessage`/`applyToEach` machinery
 *   (`mailbox-object/writes.ts`, `mailbox-object/writes-extra.ts`:
 *   `flags`, `labels.*`, `move`, `thread.label`, `thread.read`, `thread.set`,
 *   `delete`, `snooze`/`resnooze`/`unsnooze`/`snooze.wake`, `scheduled`,
 *   `delivery.match`, `inbound.finalize`, `categories`) or is a plain
 *   `UPDATE ... SET <absolute values> WHERE id = ?` outside that machinery
 *   for a table with no uniqueness constraint a duplicate insert could ever
 *   violate (`attachment.update/delete/associate`, `subscription.upsert`/
 *   `status`, `draft.update/delete`), or a bulk rewrite to an absolute
 *   target that becomes a no-op once nothing still matches the source value
 *   (`label.rename`, `label.delete`, `folder.read`).
 *
 * The `never` check below is the actual safety net: a future `MailboxOp`
 * kind must be classified here, one way or the other, before it compiles —
 * silently inheriting a retry policy that might not fit it is not an option.
 */
export function isRetryableOp(op: MailboxOp): boolean {
  switch (op.kind) {
    case 'ingest':
    case 'attachment.create':
    case 'draft.create':
    case 'flags':
    case 'labels.set':
    case 'labels.add':
    case 'labels.remove':
    case 'move':
    case 'thread.label':
    case 'thread.read':
    case 'thread.set':
    case 'label.rename':
    case 'label.delete':
    case 'delete':
    case 'snooze':
    case 'resnooze':
    case 'unsnooze':
    case 'snooze.wake':
    case 'scheduled':
    case 'delivery.match':
    case 'inbound.finalize':
    case 'categories':
    case 'attachment.update':
    case 'attachment.delete':
    case 'attachment.associate':
    case 'subscription.upsert':
    case 'subscription.status':
    case 'draft.update':
    case 'draft.delete':
    case 'folder.read':
      return true;
    default: {
      const exhaustive: never = op;
      throw new Error(`isRetryableOp: unhandled MailboxOp kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A batch is only retried whole when every op in it is individually retry-safe — one RPC call, one retry decision. */
export function isBatchRetryable(ops: readonly MailboxOp[]): boolean {
  return ops.every(isRetryableOp);
}
