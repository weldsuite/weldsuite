/**
 * Password-manager items: logins, secure notes and payment cards.
 *
 * An item is sealed as one JSON document — type, title, URL and fields — so a
 * version row is a complete, self-describing snapshot. The plain columns on
 * `weldpass_items` are derived from that document on every write and exist
 * only so a list can render and the extension can match a page without
 * decrypting anything.
 *
 * Callers resolve vault access first (`password-vaults.ts`); nothing here
 * checks who is asking.
 */

import { and, asc, desc, eq, inArray, isNull, like, or } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  hostOf,
  itemInputSchema,
  type WeldPassItemInput,
  type WeldPassItemType,
} from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { openItem, sealItem } from './envelope';
import { parseTotp, totpCode, TotpError, type TotpCode } from './totp';
import { VaultNotFoundError } from './vault';

const t = schema.weldpassItems;
const versions = schema.weldpassItemVersions;

/** A list can grow, but not without bound — a vault is not a data warehouse. */
const LIST_LIMIT = 5000;
const INSERT_CHUNK = 100;

/** A submitted field is unusable (bad 2FA secret, changed type). Answered with 400. */
export class ItemFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemFieldError';
  }
}

/** What a list shows. Nothing here is secret. */
export interface ItemSummary {
  id: string;
  vaultId: string;
  type: WeldPassItemType;
  title: string;
  subtitle: string | null;
  url: string | null;
  host: string | null;
  hasTotp: boolean;
  passwordChangedAt: Date | null;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemVersionSummary {
  id: string;
  version: number;
  action: string;
  createdBy: string | null;
  createdAt: Date;
}

const summaryColumns = {
  id: t.id,
  vaultId: t.vaultId,
  type: t.type,
  title: t.title,
  subtitle: t.subtitle,
  url: t.url,
  host: t.host,
  hasTotp: t.hasTotp,
  passwordChangedAt: t.passwordChangedAt,
  version: t.version,
  createdBy: t.createdBy,
  updatedBy: t.updatedBy,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
};

// ---------------------------------------------------------------------------
// Derived columns
// ---------------------------------------------------------------------------

interface DerivedColumns {
  title: string;
  subtitle: string | null;
  url: string | null;
  host: string | null;
  hasTotp: boolean;
}

/** The plain columns for an item, and the one place its fields are sanity-checked. */
function derive(input: WeldPassItemInput): DerivedColumns {
  if (input.type === 'login') {
    if (input.fields.totp) {
      try {
        parseTotp(input.fields.totp);
      } catch (err) {
        throw new ItemFieldError(err instanceof TotpError ? err.message : 'Invalid 2FA secret.');
      }
    }
    const url = input.url?.trim() || null;
    return {
      title: input.title,
      subtitle: input.fields.username.trim() || null,
      url,
      host: hostOf(url),
      hasTotp: Boolean(input.fields.totp),
    };
  }

  if (input.type === 'card') {
    const digits = input.fields.number.replace(/\D/g, '');
    return {
      title: input.title,
      subtitle: digits.length >= 4 ? `•••• ${digits.slice(-4)}` : null,
      url: null,
      host: null,
      hasTotp: false,
    };
  }

  return { title: input.title, subtitle: null, url: null, host: null, hasTotp: false };
}

function passwordOf(input: WeldPassItemInput): string {
  return input.type === 'login' ? input.fields.password : '';
}

async function openDocument(
  kek: Uint8Array<ArrayBuffer>,
  location: { vaultId: string; itemId: string },
  stored: { ciphertext: string; dekWrapped: string },
): Promise<WeldPassItemInput> {
  // Parsed through the schema rather than cast, so a field added later reads
  // back with its default instead of `undefined`.
  return itemInputSchema.parse(JSON.parse(await openItem(kek, location, stored)));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listItems(
  db: Database,
  vaultIds: string[],
  filter: { type?: WeldPassItemType } = {},
): Promise<ItemSummary[]> {
  if (vaultIds.length === 0) return [];
  return db
    .select(summaryColumns)
    .from(t)
    .where(
      and(
        inArray(t.vaultId, vaultIds),
        isNull(t.deletedAt),
        filter.type ? eq(t.type, filter.type) : undefined,
      ),
    )
    .orderBy(asc(t.title))
    .limit(LIST_LIMIT);
}

/**
 * Logins that belong on a page at `pageHost`, for the browser extension: the
 * same host, a parent domain, or a subdomain of it. See `hostsMatch` for why
 * the shared part must be at least two labels.
 */
export async function matchLogins(
  db: Database,
  vaultIds: string[],
  pageHost: string,
): Promise<ItemSummary[]> {
  if (vaultIds.length === 0) return [];

  const labels = pageHost.split('.');
  const parents: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) parents.push(labels.slice(i).join('.'));
  if (parents.length === 0) parents.push(pageHost);

  // Hostnames cannot contain "%", but "_" is legal in practice and is a LIKE
  // wildcard, so it is escaped rather than trusted.
  const subdomainPattern = `%.${pageHost.replace(/[\\%_]/g, (char) => `\\${char}`)}`;

  return db
    .select(summaryColumns)
    .from(t)
    .where(
      and(
        inArray(t.vaultId, vaultIds),
        eq(t.type, 'login'),
        isNull(t.deletedAt),
        or(
          inArray(t.host, parents),
          labels.length >= 2 ? like(t.host, subdomainPattern) : undefined,
        ),
      ),
    )
    .orderBy(asc(t.title))
    .limit(50);
}

export async function requireItem(
  db: Database,
  vaultId: string,
  itemId: string,
): Promise<ItemSummary> {
  const [row] = await db
    .select(summaryColumns)
    .from(t)
    .where(and(eq(t.id, itemId), eq(t.vaultId, vaultId), isNull(t.deletedAt)))
    .limit(1);
  if (!row) throw new VaultNotFoundError('item', itemId);
  return row;
}

async function requireSealedItem(db: Database, vaultId: string, itemId: string) {
  const [row] = await db
    .select({ ...summaryColumns, ciphertext: t.ciphertext, dekWrapped: t.dekWrapped })
    .from(t)
    .where(and(eq(t.id, itemId), eq(t.vaultId, vaultId), isNull(t.deletedAt)))
    .limit(1);
  if (!row) throw new VaultNotFoundError('item', itemId);
  return row;
}

/** Decrypt one item. The caller must have already resolved vault access. */
export async function revealItem(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  vaultId: string,
  itemId: string,
): Promise<{ item: ItemSummary; document: WeldPassItemInput }> {
  const { ciphertext, dekWrapped, ...item } = await requireSealedItem(db, vaultId, itemId);
  const document = await openDocument(kek, { vaultId, itemId }, { ciphertext, dekWrapped });
  return { item, document };
}

/** The current 2FA code for a login, without handing out its seed. */
export async function itemTotpCode(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  vaultId: string,
  itemId: string,
): Promise<{ item: ItemSummary; totp: TotpCode }> {
  const { item, document } = await revealItem(db, kek, vaultId, itemId);
  if (document.type !== 'login' || !document.fields.totp) {
    throw new ItemFieldError('This item has no two-factor secret.');
  }
  try {
    return { item, totp: await totpCode(parseTotp(document.fields.totp)) };
  } catch (err) {
    throw new ItemFieldError(err instanceof TotpError ? err.message : 'Invalid 2FA secret.');
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createItem(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: { vaultId: string; document: WeldPassItemInput; actorId: string },
): Promise<ItemSummary> {
  const [row] = await createItems(db, kek, {
    vaultId: input.vaultId,
    documents: [input.document],
    actorId: input.actorId,
  });
  return row;
}

/**
 * Create many items at once — a CSV import can carry hundreds.
 *
 * Everything is sealed in memory first and inserted in chunks, so the import
 * costs a handful of queries instead of two per item. Versions go in after
 * their items: an interruption leaves items without a history row, never a
 * history row pointing at nothing.
 */
export async function createItems(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: { vaultId: string; documents: WeldPassItemInput[]; actorId: string },
): Promise<ItemSummary[]> {
  const now = new Date();
  const rows = await Promise.all(
    input.documents.map(async (document) => {
      const id = generateId('wpi');
      const sealed = await sealItem(
        kek,
        { vaultId: input.vaultId, itemId: id },
        JSON.stringify(document),
      );
      return {
        id,
        vaultId: input.vaultId,
        type: document.type,
        ...derive(document),
        ...sealed,
        passwordChangedAt: passwordOf(document) ? now : null,
        version: 1,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      };
    }),
  );

  const created: ItemSummary[] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    created.push(...(await db.insert(t).values(chunk).returning(summaryColumns)));
    await db.insert(versions).values(
      chunk.map((row) => ({
        id: generateId('wph'),
        itemId: row.id,
        vaultId: row.vaultId,
        version: 1,
        action: 'created' as const,
        ciphertext: row.ciphertext,
        dekWrapped: row.dekWrapped,
        createdBy: input.actorId,
      })),
    );
  }
  return created;
}

export interface UpdateItemResult {
  item: ItemSummary;
  /** False when the submitted item matched what was already stored. */
  changed: boolean;
  passwordChanged: boolean;
}

/**
 * Replace an item. The stored document is opened first — to keep an identical
 * save from becoming a new version, and to know whether the password itself
 * changed, which is what the "old password" check is measured from.
 */
export async function updateItem(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: {
    vaultId: string;
    itemId: string;
    document: WeldPassItemInput;
    actorId: string;
    action?: 'updated' | 'restored';
  },
): Promise<UpdateItemResult> {
  const location = { vaultId: input.vaultId, itemId: input.itemId };
  const { ciphertext, dekWrapped, ...existing } = await requireSealedItem(
    db,
    input.vaultId,
    input.itemId,
  );

  if (existing.type !== input.document.type) {
    throw new ItemFieldError('An item cannot change type — create a new one instead.');
  }

  const derived = derive(input.document);
  const previous = await openDocument(kek, location, { ciphertext, dekWrapped });
  if (JSON.stringify(previous) === JSON.stringify(input.document)) {
    return { item: existing, changed: false, passwordChanged: false };
  }

  const passwordChanged = passwordOf(previous) !== passwordOf(input.document);
  const sealed = await sealItem(kek, location, JSON.stringify(input.document));
  const nextVersion = existing.version + 1;
  const now = new Date();

  // History first: if the update lands and this does not, the trail is short a
  // row; the other order could lose the only copy of the previous value.
  await db.insert(versions).values({
    id: generateId('wph'),
    itemId: input.itemId,
    vaultId: input.vaultId,
    version: nextVersion,
    action: input.action ?? 'updated',
    ...sealed,
    createdBy: input.actorId,
  });

  const [row] = await db
    .update(t)
    .set({
      ...derived,
      ...sealed,
      passwordChangedAt: passwordChanged ? now : existing.passwordChangedAt,
      version: nextVersion,
      updatedBy: input.actorId,
      updatedAt: now,
    })
    .where(eq(t.id, input.itemId))
    .returning(summaryColumns);

  return { item: row, changed: true, passwordChanged };
}

export async function deleteItem(
  db: Database,
  vaultId: string,
  itemId: string,
  actorId: string,
): Promise<ItemSummary> {
  const { ciphertext, dekWrapped, ...item } = await requireSealedItem(db, vaultId, itemId);

  const now = new Date();
  await db
    .update(t)
    .set({ deletedAt: now, updatedAt: now, updatedBy: actorId })
    .where(eq(t.id, itemId));

  // The deletion is a version too, so history reads as a complete story.
  await db.insert(versions).values({
    id: generateId('wph'),
    itemId,
    vaultId,
    version: item.version + 1,
    action: 'deleted',
    ciphertext,
    dekWrapped,
    createdBy: actorId,
  });

  return item;
}

/**
 * Move an item to another vault — how something private becomes shared.
 *
 * The item is re-sealed under the target vault's key as a *new* item and the
 * original is deleted. Its history deliberately stays behind: the people in
 * the target vault are being given this password, not every password the
 * item held before it was shared.
 */
export async function moveItem(
  db: Database,
  keys: { source: Uint8Array<ArrayBuffer>; target: Uint8Array<ArrayBuffer> },
  input: { sourceVaultId: string; targetVaultId: string; itemId: string; actorId: string },
): Promise<{ source: ItemSummary; moved: ItemSummary }> {
  const { document } = await revealItem(db, keys.source, input.sourceVaultId, input.itemId);
  const moved = await createItem(db, keys.target, {
    vaultId: input.targetVaultId,
    document,
    actorId: input.actorId,
  });
  const source = await deleteItem(db, input.sourceVaultId, input.itemId, input.actorId);
  return { source, moved };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function listItemVersions(
  db: Database,
  itemId: string,
  limit = 50,
): Promise<ItemVersionSummary[]> {
  return db
    .select({
      id: versions.id,
      version: versions.version,
      action: versions.action,
      createdBy: versions.createdBy,
      createdAt: versions.createdAt,
    })
    .from(versions)
    .where(eq(versions.itemId, itemId))
    .orderBy(desc(versions.version))
    .limit(limit);
}

/**
 * Roll an item back to an earlier version. Unlike a secret, an item's list
 * columns are derived from its contents, so the old version is opened and
 * saved again as a new one rather than copied across as ciphertext.
 */
export async function restoreItemVersion(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: { vaultId: string; itemId: string; version: number; actorId: string },
): Promise<UpdateItemResult> {
  await requireItem(db, input.vaultId, input.itemId);

  const [target] = await db
    .select({ ciphertext: versions.ciphertext, dekWrapped: versions.dekWrapped })
    .from(versions)
    .where(and(eq(versions.itemId, input.itemId), eq(versions.version, input.version)))
    .limit(1);
  if (!target) throw new VaultNotFoundError('item', `${input.itemId}@v${input.version}`);

  const document = await openDocument(
    kek,
    { vaultId: input.vaultId, itemId: input.itemId },
    target,
  );
  return updateItem(db, kek, {
    vaultId: input.vaultId,
    itemId: input.itemId,
    document,
    actorId: input.actorId,
    action: 'restored',
  });
}

// ---------------------------------------------------------------------------
// Bulk read (password health)
// ---------------------------------------------------------------------------

export interface OpenedLogin {
  item: ItemSummary;
  password: string;
}

/**
 * Open every login in the given vaults. Only `password-health.ts` calls this,
 * and nothing it reads leaves the worker — the report it builds carries item
 * ids and verdicts, never a password.
 */
export async function openLogins(
  db: Database,
  keys: Map<string, Uint8Array<ArrayBuffer>>,
): Promise<OpenedLogin[]> {
  const vaultIds = [...keys.keys()];
  if (vaultIds.length === 0) return [];

  const rows = await db
    .select({ ...summaryColumns, ciphertext: t.ciphertext, dekWrapped: t.dekWrapped })
    .from(t)
    .where(and(inArray(t.vaultId, vaultIds), eq(t.type, 'login'), isNull(t.deletedAt)))
    .orderBy(asc(t.title))
    .limit(LIST_LIMIT);

  const opened: OpenedLogin[] = [];
  for (const { ciphertext, dekWrapped, ...item } of rows) {
    const kek = keys.get(item.vaultId);
    if (!kek) continue;
    const document = await openDocument(
      kek,
      { vaultId: item.vaultId, itemId: item.id },
      { ciphertext, dekWrapped },
    );
    opened.push({ item, password: passwordOf(document) });
  }
  return opened;
}
