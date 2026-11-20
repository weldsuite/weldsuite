/**
 * How often a caller id verification code may be sent and tried, per hour.
 *
 * Every send makes Telnyx call or text the number, and a code is a few digits:
 * without a limit a member could have a number rung without end, or guess the
 * code of a number that is not theirs. The counters live in the worker's KV
 * (WORKSPACE_CACHE), one key per clock hour; without KV, or when it fails,
 * nothing is limited (as the other KV-backed limits behave).
 */

/** Codes sent to one number per hour. */
export const SIP_VERIFICATION_SENDS_PER_NUMBER = 3;
/** Codes sent by one workspace per hour, over all its numbers. */
export const SIP_VERIFICATION_SENDS_PER_WORKSPACE = 10;
/** Codes tried on one number per hour. */
export const SIP_VERIFICATION_CONFIRMS_PER_NUMBER = 5;

const WINDOW_MS = 60 * 60 * 1000;
/** Twice the window: a counter outlives its hour, never the next one. */
const COUNTER_TTL_SECONDS = 2 * 60 * 60;

type CounterKv = Partial<Pick<KVNamespace, 'get' | 'put'>>;

/**
 * Count one attempt in this hour's window of `scope`. Null while the window
 * has room; once it holds more than `max`, the seconds until it ends.
 */
export async function countVerificationAttempt(
  env: { WORKSPACE_CACHE?: unknown },
  scope: string,
  max: number,
  now: number = Date.now(),
): Promise<number | null> {
  const kv = env.WORKSPACE_CACHE as CounterKv | undefined;
  if (typeof kv?.get !== 'function' || typeof kv.put !== 'function') return null;
  const window = Math.floor(now / WINDOW_MS);
  const key = `sip-verify:${scope}:${window}`;
  try {
    const used = Number.parseInt((await kv.get(key)) ?? '0', 10);
    const count = (Number.isFinite(used) ? used : 0) + 1;
    await kv.put(key, String(count), { expirationTtl: COUNTER_TTL_SECONDS });
    if (count <= max) return null;
    return Math.max(1, Math.ceil(((window + 1) * WINDOW_MS - now) / 1000));
  } catch (err) {
    console.warn('[sip-trunks] verification counter unavailable:', err);
    return null;
  }
}
