/**
 * Pure helpers for finding the thread an inbound message belongs to.
 *
 * Senders disagree on the angle brackets of a Message-ID (`<id@host>` versus
 * `id@host`) and on reply prefixes (`Re:`, `RE:`, `Aw:`, `Re[2]:`), and some
 * replies carry no In-Reply-To / References at all. These helpers make the
 * lookups in `email-storage.ts` tolerant of all three.
 */

/** One reply or forward prefix (`Re:`, `FWD:`, `Aw:`, `RE[2]:`). Stripped in a loop, so it never backtracks. */
const SUBJECT_PREFIX = /^(?:re|fwd?|aw|sv|vs|antw)(?:\[\d+\])?\s*:/i;

/** The subject with every leading reply / forward prefix removed, and whether there was one. */
function stripSubjectPrefixes(subject: string): { bare: string; prefixed: boolean } {
  let rest = subject.trim();
  let prefixed = false;
  for (let match = SUBJECT_PREFIX.exec(rest); match; match = SUBJECT_PREFIX.exec(rest)) {
    rest = rest.slice(match[0].length).trimStart();
    prefixed = true;
  }
  return { bare: rest.trim(), prefixed };
}

/** The Message-ID without its angle brackets. */
export function bareMessageId(id: string): string {
  const isEdge = (ch: string, bracket: string) => ch === bracket || ch.trim() === '';
  let start = 0;
  let end = id.length;
  while (start < end && isEdge(id.charAt(start), '<')) start++;
  while (end > start && isEdge(id.charAt(end - 1), '>')) end--;
  return id.slice(start, end);
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
  return stripSubjectPrefixes(subject ?? '').bare;
}

/** The subject says it answers or forwards something (`Re:`, `Fwd:`, ...). */
export function hasReplyPrefix(subject: string | null | undefined): boolean {
  return stripSubjectPrefixes(subject ?? '').prefixed;
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
  let list: unknown[] = [];
  if (Array.isArray(value)) list = value;
  else if (value) list = [value];
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
