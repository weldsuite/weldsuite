/**
 * Identity codes for signing links: a 6-digit code emailed when the link is
 * opened (auth mode `email_code`), or the access code the sender shared
 * (`access_code`). Kept in KV under the link's token hash:
 *
 *   sign:code:<tokenHash>   the emailed code's keyed hash, 10 minutes
 *   sign:sent:<tokenHash>   last time a code was emailed (resend throttle), 1 minute
 *
 * Wrong answers are counted by the link's `SignCodeAttempts` Durable Object
 * (../durable-objects/code-attempts.ts), not in KV: KV has no atomic increment,
 * so parallel `/verify` calls would each read the same count and all get a
 * guess before the lock landed. The Durable Object settles one answer at a
 * time, so five wrong answers lock the link for 15 minutes however many arrive
 * at once. Both kinds of code are compared in their stored form, `codeHash`
 * (./hash.ts).
 */

/** Turns a code into its stored form (`codeHash`, bound to the recipient). */
export type CodeHasher = (code: string) => Promise<string>;

export const CODE_TTL_SECONDS = 10 * 60;
export const MAX_TRIES = 5;
export const LOCK_SECONDS = 15 * 60;
export const RESEND_AFTER_SECONDS = 60;

const codeKey = (tokenHash: string) => `sign:code:${tokenHash}`;
const sentKey = (tokenHash: string) => `sign:sent:${tokenHash}`;

export function newEmailCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, '0');
}

/** Store a fresh code for this link; false when one was sent less than a minute ago. */
export async function issueEmailCode(kv: KVNamespace, tokenHash: string, code: string, hash: CodeHasher): Promise<boolean> {
  if (await kv.get(sentKey(tokenHash))) return false;
  await Promise.all([
    kv.put(codeKey(tokenHash), await hash(code), { expirationTtl: CODE_TTL_SECONDS }),
    kv.put(sentKey(tokenHash), '1', { expirationTtl: RESEND_AFTER_SECONDS }),
  ]);
  return true;
}

export type CodeCheck = { ok: true } | { ok: false; locked: boolean; attemptsLeft: number };

/** One link's wrong-answer count: its `SignCodeAttempts` Durable Object, or an in-memory one in tests. */
export interface CodeAttempts {
  tries(): Promise<number>;
  /** Settle one answer: refused while locked, clears the count on a match, else counts a miss. */
  attempt(match: boolean): Promise<CodeCheck>;
}

/** The storage `AttemptCounter` needs: Durable Object storage, or a Map in tests. */
export interface AttemptStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Wrong answers so far, and when they are forgotten. */
interface AttemptState {
  tries: number;
  until: number;
}

const STATE_KEY = 'state';

/**
 * The lockout rule, kept apart from the Durable Object so tests can run it on a
 * Map. Each wrong answer restarts the 15-minute window. It is only atomic when
 * calls run one at a time, which is what the Durable Object guarantees.
 */
export class AttemptCounter implements CodeAttempts {
  constructor(
    private readonly store: AttemptStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** When the stored count is forgotten (ms), or null when there is none. */
  async expiresAt(): Promise<number | null> {
    return (await this.store.get<AttemptState>(STATE_KEY))?.until ?? null;
  }

  async tries(): Promise<number> {
    const state = await this.store.get<AttemptState>(STATE_KEY);
    return state && state.until > this.now() ? state.tries : 0;
  }

  async attempt(match: boolean): Promise<CodeCheck> {
    const tries = await this.tries();
    if (tries >= MAX_TRIES) return { ok: false, locked: true, attemptsLeft: 0 };
    if (match) {
      await this.store.delete(STATE_KEY);
      return { ok: true };
    }
    const next = tries + 1;
    await this.store.put<AttemptState>(STATE_KEY, { tries: next, until: this.now() + LOCK_SECONDS * 1000 });
    return { ok: false, locked: next >= MAX_TRIES, attemptsLeft: Math.max(MAX_TRIES - next, 0) };
  }
}

export async function isLocked(attempts: CodeAttempts): Promise<boolean> {
  return (await attempts.tries()) >= MAX_TRIES;
}

/**
 * Compare an answer with the expected hash, then let the link's counter settle
 * it. The answer is hashed first; only the counter decides, so a correct code
 * sent while the link is locked is still refused.
 */
export async function checkCode(
  kv: KVNamespace,
  attempts: CodeAttempts,
  tokenHash: string,
  expectedHash: string | null,
  answer: string,
  hash: CodeHasher,
): Promise<CodeCheck> {
  const match = expectedHash !== null && (await hash(answer)) === expectedHash;
  const result = await attempts.attempt(match);
  if (result.ok) await kv.delete(codeKey(tokenHash));
  return result;
}

/** The emailed code's hash for this link, if one is still valid. */
export async function emailCodeHash(kv: KVNamespace, tokenHash: string): Promise<string | null> {
  return kv.get(codeKey(tokenHash));
}

/** `ann@example.com` → `a••@example.com`, to say where the code went. */
export function emailHint(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  return `${local[0]}${'•'.repeat(Math.min(Math.max(local.length - 1, 2), 6))}@${domain}`;
}
