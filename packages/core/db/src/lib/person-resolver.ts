/**
 * Person resolver — runtime-agnostic `find or create person by email` helper.
 *
 * Workers (agent-service, helpdesk-workflow-worker, integration sync, trigger
 * jobs, …) routinely need to attach an incoming email to a Person identity row.
 * Before this helper existed, each runtime either duplicated the logic
 * (`apps/core-api/src/lib/participant-resolver.ts`, `apps/workers/app-api/src/services/people.ts:findOrCreatePersonByEmail`)
 * or — worse — queried the soon-to-be-retired `contacts` table directly.
 *
 * Style mirrors `mail-contacts.ts`: loose `AnyDb` type so each caller's drizzle
 * generic works, caller-provided `IdGenerator` so we don't bake one runtime's
 * id format in here.
 *
 * Avatar generation is the caller's responsibility — keyed off the `created`
 * flag in the return value.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';

export interface ResolvePersonInput {
  email: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface ResolvedPerson {
  personId: string;
  email: string;
  displayName: string;
  /** True when this call created the row; false when an existing person matched. */
  created: boolean;
}

import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@') || trimmed.length > 255) return null;
  return trimmed;
}

/**
 * Split a display name. Last whitespace-separated token becomes lastName so
 * multi-word first names ("Mary Jane Smith" → first="Mary Jane", last="Smith")
 * survive intact.
 */
function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const tokens = displayName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0]!, lastName: '' };
  return {
    firstName: tokens.slice(0, -1).join(' '),
    lastName: tokens[tokens.length - 1]!,
  };
}

function deriveNames(
  email: string,
  input: { firstName?: string | null; lastName?: string | null; displayName?: string | null },
): { firstName: string; lastName: string } {
  const explicitFirst = input.firstName?.trim();
  const explicitLast = input.lastName?.trim();
  if (explicitFirst || explicitLast) {
    return { firstName: explicitFirst ?? '', lastName: explicitLast ?? '' };
  }
  if (input.displayName?.trim()) {
    const split = splitDisplayName(input.displayName);
    if (split.firstName || split.lastName) return split;
  }
  const localPart = email.split('@')[0] ?? email;
  return { firstName: localPart || email, lastName: '' };
}

function deriveDisplayName(
  firstName: string,
  lastName: string,
  fullName: string | null,
  email: string,
): string {
  const combined = `${firstName} ${lastName}`.trim();
  return combined || fullName || email;
}

/**
 * Find a person by case-insensitive email, or create a minimal guest row if
 * none exists. Soft-deleted rows are excluded — a fresh row is inserted
 * instead of resurrecting a deleted one.
 *
 * Skips empty / malformed emails (returns `null`).
 *
 * Existing-row policy: CRM-curated data wins; we never overwrite names/fields
 * on an existing row.
 */
export async function findOrCreatePersonByEmail(
  db: AnyDb,
  input: ResolvePersonInput,
  generateId: IdGenerator,
): Promise<ResolvedPerson | null> {
  const email = normalizeEmail(input.email);
  if (!email) return null;

  const existing = await db
    .select({
      id: schema.people.id,
      displayName: schema.people.displayName,
    })
    .from(schema.people)
    .where(and(sql`LOWER(${schema.people.email}) = ${email}`, isNull(schema.people.deletedAt)))
    .limit(1);

  const [hit] = existing;
  if (hit) {
    return {
      personId: hit.id,
      email,
      displayName: hit.displayName,
      created: false,
    };
  }

  const { firstName, lastName } = deriveNames(email, input);
  const fullName = lastName ? `${firstName} ${lastName}`.trim() : firstName;
  const displayName = deriveDisplayName(firstName, lastName, fullName, email);
  const id = generateId('person');
  const now = new Date();

  await db.insert(schema.people).values({
    id,
    createdAt: now,
    updatedAt: now,
    version: 1,
    firstName: firstName || null,
    lastName: lastName || null,
    fullName: fullName || null,
    displayName,
    email,
    status: 'active',
    // Guest row auto-created from an inbound email — a mail identity, not a
    // CRM member. Stays out of the CRM grid until explicitly added.
    inCrm: false,
  });

  return { personId: id, email, displayName, created: true };
}

/**
 * Batch variant. Dedupes by normalized email, does one SELECT to find existing
 * rows, then one INSERT per missing row. Returns one entry per valid input
 * email (skipping invalid ones).
 */
export async function findOrCreatePeopleByEmailBatch(
  db: AnyDb,
  inputs: ResolvePersonInput[],
  generateId: IdGenerator,
): Promise<ResolvedPerson[]> {
  if (!inputs || inputs.length === 0) return [];

  const byEmail = new Map<string, ResolvePersonInput>();
  for (const input of inputs) {
    const email = normalizeEmail(input.email);
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, { ...input, email });
  }
  if (byEmail.size === 0) return [];

  const emails = Array.from(byEmail.keys());

  const existing = await db
    .select({
      id: schema.people.id,
      email: schema.people.email,
      displayName: schema.people.displayName,
    })
    .from(schema.people)
    .where(
      and(
        sql`LOWER(${schema.people.email}) IN (${sql.join(
          emails.map((e) => sql`${e}`),
          sql`, `,
        )})`,
        isNull(schema.people.deletedAt),
      ),
    );

  const existingByEmail = new Map<string, { id: string; displayName: string }>();
  for (const row of existing) {
    if (row.email) existingByEmail.set(row.email.toLowerCase(), { id: row.id, displayName: row.displayName });
  }

  const results: ResolvedPerson[] = [];
  const now = new Date();

  for (const email of emails) {
    const hit = existingByEmail.get(email);
    if (hit) {
      results.push({ personId: hit.id, email, displayName: hit.displayName, created: false });
      continue;
    }
    const input = byEmail.get(email)!;
    const { firstName, lastName } = deriveNames(email, input);
    const fullName = lastName ? `${firstName} ${lastName}`.trim() : firstName;
    const displayName = deriveDisplayName(firstName, lastName, fullName, email);
    const id = generateId('person');

    await db.insert(schema.people).values({
      id,
      createdAt: now,
      updatedAt: now,
      version: 1,
      firstName: firstName || null,
      lastName: lastName || null,
      fullName: fullName || null,
      displayName,
      email,
      status: 'active',
      // Guest row auto-created from an inbound email — kept out of the CRM.
      inCrm: false,
    });

    results.push({ personId: id, email, displayName, created: true });
  }

  return results;
}
