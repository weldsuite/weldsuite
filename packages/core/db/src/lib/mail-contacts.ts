/**
 * Mail identity upsert helpers — write to the new `people` table.
 *
 * When an email passes through the mail pipeline (inbound, outbound, helpdesk),
 * we record every distinct `from`/`to`/`cc`/`bcc` address as a row in `people`
 * so mail senders/recipients have a stable id for avatars + compose autocomplete.
 *
 * Runtime-agnostic (no Hono / no R2 / no fetch). Avatar generation is the
 * caller's responsibility, keyed off the `created` flag in the return value.
 *
 * The file is named `mail-contacts.ts` for backwards-compat with existing
 * imports; the export names also kept the `Contact`/`contactId` words to avoid
 * a wide rename. Internally everything is `schema.people` now.
 */

import { eq, inArray, isNull, and, sql } from 'drizzle-orm';
import * as schema from '../schema';

/** Single mail email address — matches `MailEmailAddress` shape on mail_messages. */
export interface MailContactAddress {
  email: string;
  name?: string | null;
}

/** Result of a single upsert. `contactId` is the resolved `people.id`. */
export interface MailContactUpsertResult {
  contactId: string;
  email: string;
  created: boolean;
}

/** Caller-provided ID generator (so each runtime can use its own). */
export type IdGenerator = (prefix: string) => string;

function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!trimmed.includes('@') || trimmed.length > 255) return null;
  return trimmed;
}

function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const tokens = displayName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0]!, lastName: '' };
  return {
    firstName: tokens.slice(0, -1).join(' '),
    lastName: tokens[tokens.length - 1]!,
  };
}

function deriveNames(email: string, displayName?: string | null): { firstName: string; lastName: string } {
  if (displayName && displayName.trim()) {
    const split = splitDisplayName(displayName);
    if (split.firstName) return split;
  }
  const localPart = email.split('@')[0] ?? email;
  return { firstName: localPart || email, lastName: '' };
}

function buildDisplayName(firstName: string, lastName: string, email: string): string {
  const combined = `${firstName} ${lastName}`.trim();
  return combined || email;
}

import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Upsert a single mail person by email. Skips empty / malformed emails.
 * Existing rows win — never overwrites curated names.
 */
export async function upsertMailContact(
  db: AnyDb,
  address: MailContactAddress,
  generateId: IdGenerator,
): Promise<MailContactUpsertResult | null> {
  const email = normalizeEmail(address.email);
  if (!email) return null;

  const existing = await db
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(and(sql`LOWER(${schema.people.email}) = ${email}`, isNull(schema.people.deletedAt)))
    .limit(1);

  const [hit] = existing;
  if (hit) {
    return { contactId: hit.id, email, created: false };
  }

  const { firstName, lastName } = deriveNames(email, address.name);
  const id = generateId('person');
  const now = new Date();
  const fullName = lastName ? `${firstName} ${lastName}`.trim() : firstName;
  const displayName = buildDisplayName(firstName, lastName, email);

  await db.insert(schema.people).values({
    id,
    firstName: firstName || null,
    lastName: lastName || null,
    fullName: fullName || null,
    displayName,
    email,
    status: 'active',
    // Mail-pipeline identity — kept out of the CRM until a user explicitly
    // adds them via the person panel's "Add to CRM" button.
    inCrm: false,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });

  return { contactId: id, email, created: true };
}

/**
 * Upsert many mail people in a single round trip.
 * Dedupes by normalized email, one SELECT to find existing rows, one INSERT per missing.
 * Returns one entry per valid input email (skipping invalid ones).
 */
export async function upsertMailContactsBatch(
  db: AnyDb,
  addresses: MailContactAddress[],
  generateId: IdGenerator,
): Promise<MailContactUpsertResult[]> {
  if (!addresses || addresses.length === 0) return [];

  const byEmail = new Map<string, MailContactAddress>();
  for (const addr of addresses) {
    const normalized = normalizeEmail(addr.email);
    if (!normalized) continue;
    if (!byEmail.has(normalized)) {
      byEmail.set(normalized, { email: normalized, name: addr.name ?? null });
    } else if (!byEmail.get(normalized)!.name && addr.name) {
      byEmail.set(normalized, { email: normalized, name: addr.name });
    }
  }

  if (byEmail.size === 0) return [];

  const emails = Array.from(byEmail.keys());

  const existingRows = (await db
    .select({ id: schema.people.id, email: schema.people.email })
    .from(schema.people)
    .where(
      and(
        sql`LOWER(${schema.people.email}) IN (${sql.join(
          emails.map((e) => sql`${e}`),
          sql`, `,
        )})`,
        isNull(schema.people.deletedAt),
      ),
    )) as Array<{ id: string; email: string | null }>;

  const existingByEmail = new Map<string, string>();
  for (const row of existingRows) {
    if (row.email) existingByEmail.set(row.email.toLowerCase(), row.id);
  }

  const results: MailContactUpsertResult[] = [];
  const toInsert: Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    displayName: string;
    email: string;
    status: 'active';
    inCrm: boolean;
    createdAt: Date;
    updatedAt: Date;
    version: number;
  }> = [];

  const now = new Date();
  for (const [email, addr] of byEmail) {
    const existingId = existingByEmail.get(email);
    if (existingId) {
      results.push({ contactId: existingId, email, created: false });
      continue;
    }
    const { firstName, lastName } = deriveNames(email, addr.name);
    const id = generateId('person');
    const fullName = lastName ? `${firstName} ${lastName}`.trim() : firstName;
    const displayName = buildDisplayName(firstName, lastName, email);
    toInsert.push({
      id,
      firstName: firstName || null,
      lastName: lastName || null,
      fullName: fullName || null,
      displayName,
      email,
      status: 'active',
      // Mail-pipeline identity — kept out of the CRM until explicitly added.
      inCrm: false,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    results.push({ contactId: id, email, created: true });
  }

  if (toInsert.length > 0) {
    // Concurrent writes for the same email can race. Drizzle has no
    // ON CONFLICT we can rely on (email isn't unique), so swallow duplicates
    // and re-resolve the losers.
    try {
      await db.insert(schema.people).values(toInsert);
    } catch (err) {
      for (const row of toInsert) {
        try {
          await db.insert(schema.people).values(row);
        } catch {
          const [winner] = await db
            .select({ id: schema.people.id })
            .from(schema.people)
            .where(and(eq(schema.people.email, row.email), isNull(schema.people.deletedAt)))
            .limit(1);
          if (winner) {
            const idx = results.findIndex((r) => r.email === row.email && r.created);
            if (idx >= 0) results[idx] = { contactId: winner.id, email: row.email, created: false };
          }
        }
      }
      console.error('[mail-contacts] Batch insert hit a conflict, fell back to per-row:', err);
    }
  }

  return results;
}

/**
 * Generate a 128×128 SVG avatar with deterministic colour + initials.
 */
export function generateInitialsAvatarSvg(name: string): string {
  const colors = [
    '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
    '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const bg = colors[Math.abs(hash) % colors.length];

  const initials = (name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase()) || '?';

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
    `<rect width="128" height="128" rx="16" fill="${bg}"/>`,
    '<text x="64" y="64" text-anchor="middle" dominant-baseline="central"',
    ' font-family="system-ui,sans-serif" font-weight="600"',
    ` font-size="${initials.length > 1 ? '48' : '56'}" fill="#fff">`,
    initials,
    '</text>',
    '</svg>',
  ].join('');
}

/**
 * Build the R2 key + public URL for a person avatar.
 * Now writes under `workspaces/{workspaceId}/avatars/people/{personId}/...`
 * (the old `contacts` folder is unused after the contacts→people cutover).
 */
export function buildContactAvatarPath(workspaceId: string, personId: string): {
  r2Key: string;
  publicPath: string;
} {
  const r2Key = `workspaces/${workspaceId}/avatars/people/${personId}/logo.svg`;
  return { r2Key, publicPath: r2Key };
}

/**
 * Flatten the address fields from a mail message into a single list, suitable
 * for passing to `upsertMailContactsBatch`. Drops null / empty entries.
 */
export function collectMailMessageAddresses(message: {
  from?: MailContactAddress | null;
  to?: MailContactAddress[] | null;
  cc?: MailContactAddress[] | null;
  bcc?: MailContactAddress[] | null;
  replyTo?: MailContactAddress | null;
}): MailContactAddress[] {
  const out: MailContactAddress[] = [];
  if (message.from?.email) out.push(message.from);
  if (message.replyTo?.email) out.push(message.replyTo);
  for (const arr of [message.to, message.cc, message.bcc]) {
    if (!arr) continue;
    for (const addr of arr) {
      if (addr?.email) out.push(addr);
    }
  }
  return out;
}
