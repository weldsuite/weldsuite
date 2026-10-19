/**
 * Pure helpers for finding the thread an inbound message belongs to.
 *
 * Senders disagree on the angle brackets of a Message-ID (`<id@host>` versus
 * `id@host`) and on reply prefixes (`Re:`, `RE:`, `Aw:`, `Re[2]:`), and some
 * replies carry no In-Reply-To / References at all. These helpers make the
 * lookups in `email-storage.ts` tolerant of all three.
 */

/** A reply or forward prefix, repeated any number of times (`Re: Fwd: RE[2]: `). */
const SUBJECT_PREFIXES = /^(?:\s*(?:re|fwd?|aw|sv|vs|antw)(?:\[\d+\])?\s*:)+\s*/i;

/** The Message-ID without its angle brackets. */
export function bareMessageId(id: string): string {
  return id.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
}

/** Every Message-ID in both spellings (`id@host` and `<id@host>`), without duplicates. */
export function messageIdVariants(ids: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const raw of ids) {
    const bare = bareMessageId(raw);
    if (!bare) continue;
    variants.add(bare);
    variants.add(`<${bare}>`);
  }
  return [...variants];
}

/** The local part of each Message-ID: how a provider that rewrites the host names the same message. */
export function providerMessageIds(ids: readonly string[]): string[] {
  const locals = new Set<string>();
  for (const raw of ids) {
    const local = bareMessageId(raw).replace(/@[\s\S]*/, '');
    if (local) locals.add(local);
  }
  return [...locals];
}

/** The subject without any reply / forward prefixes. */
export function bareSubject(subject: string | null | undefined): string {
  return (subject ?? '').replace(SUBJECT_PREFIXES, '').trim();
}

/** The subject says it answers or forwards something (`Re:`, `Fwd:`, ...). */
export function hasReplyPrefix(subject: string | null | undefined): boolean {
  return SUBJECT_PREFIXES.test(subject ?? '');
}

/** The lower-cased subjects an earlier message of the same conversation may carry. */
export function conversationSubjects(subject: string | null | undefined): string[] {
  const bare = bareSubject(subject).toLowerCase();
  return bare ? [bare, `re: ${bare}`] : [];
}

interface Addressed {
  from?: unknown;
  to?: unknown;
  cc?: unknown;
}

function emailsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((entry) => (entry as { email?: unknown } | null)?.email)
    .filter((email): email is string => typeof email === 'string' && email.length > 0)
    .map((email) => email.toLowerCase());
}

/** The address is the sender or a recipient of the stored message. */
export function involvesAddress(message: Addressed, address: string | undefined): boolean {
  if (!address) return false;
  const wanted = address.toLowerCase();
  return [...emailsOf(message.from), ...emailsOf(message.to), ...emailsOf(message.cc)].includes(wanted);
}
