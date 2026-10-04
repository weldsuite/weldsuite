/**
 * WeldPass password manager routes — mounted under /api/weldpass.
 *
 * Workspace permissions (see packages/core/permissions/src/catalog.ts):
 *   passwords:use     use the password manager at all: your personal vault and
 *                     the shared vaults you are a member of
 *   passwords:create  create shared vaults
 *   passwords:manage  see every shared vault and fix its membership
 *
 * Those only open the door. What a caller may do inside a vault is decided by
 * their role *on that vault* (viewer / editor / manager), resolved per request
 * in `services/weldpass/password-vaults.ts`. Holding `passwords:manage` does
 * not read anyone's passwords: a personal vault resolves for its owner alone,
 * and a shared vault's items still take membership.
 *
 * Like the rest of WeldPass this publishes no entity events; it writes its own
 * trail to `weldpass_vault_events`, reveals included.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import {
  addVaultMemberSchema,
  createVaultSchema,
  hostOf,
  importItemsSchema,
  itemInputSchema,
  moveItemSchema,
  restoreItemSchema,
  updateVaultMemberSchema,
  updateVaultSchema,
  weldpassItemTypeSchema,
} from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { auditContextFrom } from '../../services/weldpass/audit';
import { buildHealthReport } from '../../services/weldpass/password-health';
import { parseImport } from '../../services/weldpass/password-import';
import {
  createItem,
  createItems,
  deleteItem,
  itemTotpCode,
  listItems,
  listItemVersions,
  matchLogins,
  moveItem,
  openLogins,
  requireItem,
  restoreItemVersion,
  revealItem,
  updateItem,
} from '../../services/weldpass/password-items';
import {
  addVaultMember,
  assertVaultAdmin,
  assertVaultRole,
  createSharedVault,
  deleteVault,
  ensurePersonalVault,
  listTeammates,
  listVaultMembers,
  listVaults,
  openPasswordVault,
  removeVaultMember,
  requireVaultAccess,
  setVaultMemberRole,
  updateVault,
  VaultAccessError,
} from '../../services/weldpass/password-vaults';
import { listVaultEvents, recordVaultEvent } from '../../services/weldpass/vault-events';
import { keyring } from './helpers';

type PasswordsContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const VAULT = '/vaults/:vaultId';
const ITEM = `${VAULT}/items/:itemId`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a path parameter the route is known to declare (see helpers.ts). */
function pathParam(c: PasswordsContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`WeldPass route is missing the :${name} parameter`);
  return value;
}

/** The `:vaultId` in the path, resolved for this caller. */
async function vaultFor(c: PasswordsContext) {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const canManageAll = await hasContextPermission(c, 'passwords:manage');
  const access = await requireVaultAccess(
    db,
    c.get('workspaceId'),
    userId,
    pathParam(c, 'vaultId'),
    { canManageAll },
  );
  return { db, userId, access, vault: access.vault, canManageAll };
}

/** The ids of the vaults whose items the caller may read — membership only. */
async function readableVaultIds(c: PasswordsContext): Promise<string[]> {
  const vaults = await listVaults(c.get('tenantDb'), c.get('workspaceId'), c.get('userId'));
  return vaults.map((vault) => vault.id);
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

app.get('/vaults', requirePermission('passwords:use'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');

  await ensurePersonalVault(db, workspaceId, keyring(c), userId);
  const canManageAll = await hasContextPermission(c, 'passwords:manage');
  return success(c, await listVaults(db, workspaceId, userId, { canManageAll }));
});

app.post(
  '/vaults',
  requirePermission('passwords:create', 'passwords:manage'),
  zValidator('json', createVaultSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const body = c.req.valid('json');

    const vault = await createSharedVault(db, c.get('workspaceId'), keyring(c), {
      name: body.name,
      description: body.description ?? null,
      createdBy: userId,
    });

    await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
      vaultId: vault.id,
      actorId: userId,
      action: 'vault.created',
      targetLabel: vault.name,
    });

    return success(c, { ...vault, role: 'manager' as const, itemCount: 0, memberCount: 1 }, 201);
  },
);

app.get(VAULT, requirePermission('passwords:use'), async (c) => {
  const { access } = await vaultFor(c);
  return success(c, { ...access.vault, role: access.role });
});

app.patch(
  VAULT,
  requirePermission('passwords:use'),
  zValidator('json', updateVaultSchema),
  async (c) => {
    const { db, userId, access, vault, canManageAll } = await vaultFor(c);
    assertVaultAdmin(access, canManageAll);

    const updated = await updateVault(db, vault.id, c.req.valid('json'));
    await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
      vaultId: vault.id,
      actorId: userId,
      action: 'vault.updated',
      targetLabel: updated.name,
    });

    return success(c, { ...updated, role: access.role });
  },
);

app.delete(VAULT, requirePermission('passwords:use'), async (c) => {
  const { db, userId, access, vault, canManageAll } = await vaultFor(c);
  assertVaultAdmin(access, canManageAll);

  await deleteVault(db, vault.id);
  await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
    vaultId: vault.id,
    actorId: userId,
    action: 'vault.deleted',
    targetLabel: vault.name,
  });

  return noContent(c);
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** Who a vault can be shared with. Names and emails only. */
app.get('/teammates', requirePermission('passwords:use'), async (c) => {
  return success(c, await listTeammates(c.get('tenantDb')));
});

app.get(`${VAULT}/members`, requirePermission('passwords:use'), async (c) => {
  const { db, vault } = await vaultFor(c);
  if (vault.kind === 'personal') return success(c, []);
  return success(c, await listVaultMembers(db, vault.id));
});

app.post(
  `${VAULT}/members`,
  requirePermission('passwords:use'),
  zValidator('json', addVaultMemberSchema),
  async (c) => {
    const { db, userId, access, vault, canManageAll } = await vaultFor(c);
    assertVaultAdmin(access, canManageAll);
    const body = c.req.valid('json');

    const { created } = await addVaultMember(db, vault.id, {
      userId: body.userId,
      role: body.role,
      addedBy: userId,
    });

    await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
      vaultId: vault.id,
      actorId: userId,
      action: created ? 'member.added' : 'member.role_changed',
      targetLabel: body.userId,
      metadata: { role: body.role },
    });

    return success(c, await listVaultMembers(db, vault.id), created ? 201 : 200);
  },
);

app.patch(
  `${VAULT}/members/:userId`,
  requirePermission('passwords:use'),
  zValidator('json', updateVaultMemberSchema),
  async (c) => {
    const { db, userId, access, vault, canManageAll } = await vaultFor(c);
    assertVaultAdmin(access, canManageAll);
    const memberId = pathParam(c, 'userId');
    const { role } = c.req.valid('json');

    const { previous } = await setVaultMemberRole(db, vault.id, memberId, role);
    await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
      vaultId: vault.id,
      actorId: userId,
      action: 'member.role_changed',
      targetLabel: memberId,
      metadata: { from: previous, to: role },
    });

    return success(c, await listVaultMembers(db, vault.id));
  },
);

app.delete(`${VAULT}/members/:userId`, requirePermission('passwords:use'), async (c) => {
  const { db, userId, access, vault, canManageAll } = await vaultFor(c);
  const memberId = pathParam(c, 'userId');

  // Anyone may leave a vault; removing somebody else takes a manager.
  if (memberId !== userId) assertVaultAdmin(access, canManageAll);
  else if (vault.kind === 'personal') {
    throw new VaultAccessError('A personal vault cannot be shared, renamed or deleted.');
  }

  await removeVaultMember(db, vault.id, memberId);
  await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
    vaultId: vault.id,
    actorId: userId,
    action: 'member.removed',
    targetLabel: memberId,
    metadata: { left: memberId === userId },
  });

  return noContent(c);
});

/**
 * A vault's trail. It shows who revealed which login and when — exactly the
 * map a curious low-privilege member would want — so it takes a manager.
 */
app.get(`${VAULT}/activity`, requirePermission('passwords:use'), async (c) => {
  const { db, access, vault, canManageAll } = await vaultFor(c);
  if (access.role !== 'manager' && !canManageAll) {
    throw new VaultAccessError('This needs the manager role on the vault.');
  }

  const rawLimit = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

  const cursorValue = c.req.query('cursor');
  const before = cursorValue ? new Date(cursorValue) : null;
  const rows = await listVaultEvents(db, vault.id, {
    limit,
    before: before && !Number.isNaN(before.getTime()) ? before : null,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null;

  return list(c, page, cursorPagination(page.length, hasMore, cursor));
});

// ---------------------------------------------------------------------------
// Items — across vaults
// ---------------------------------------------------------------------------

/** Every item the caller can open, or one vault's. Titles and sites only. */
app.get('/items', requirePermission('passwords:use'), async (c) => {
  const readable = await readableVaultIds(c);

  const vaultId = c.req.query('vaultId');
  if (vaultId && !readable.includes(vaultId)) return error.notFound(c, 'vault', vaultId);

  const type = weldpassItemTypeSchema.safeParse(c.req.query('type'));
  return success(
    c,
    await listItems(c.get('tenantDb'), vaultId ? [vaultId] : readable, {
      type: type.success ? type.data : undefined,
    }),
  );
});

/** Logins saved for the site at `?url=` — what the browser extension asks. */
app.get('/items/match', requirePermission('passwords:use'), async (c) => {
  const host = hostOf(c.req.query('url'));
  if (!host) return success(c, []);
  return success(c, await matchLogins(c.get('tenantDb'), await readableVaultIds(c), host));
});

/**
 * Weak, reused and old passwords across the caller's vaults. The logins are
 * opened in memory to compare them; the response carries verdicts only.
 */
app.get('/password-health', requirePermission('passwords:use'), async (c) => {
  const db = c.get('tenantDb');
  const keys = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const vaultId of await readableVaultIds(c)) {
    keys.set(vaultId, await openPasswordVault(db, keyring(c), vaultId));
  }
  return success(c, buildHealthReport(await openLogins(db, keys)));
});

// ---------------------------------------------------------------------------
// Items — in a vault
// ---------------------------------------------------------------------------

app.post(
  `${VAULT}/items`,
  requirePermission('passwords:use'),
  zValidator('json', itemInputSchema),
  async (c) => {
    const { db, userId, access, vault } = await vaultFor(c);
    assertVaultRole(access, 'editor');

    const kek = await openPasswordVault(db, keyring(c), vault.id);
    const item = await createItem(db, kek, {
      vaultId: vault.id,
      document: c.req.valid('json'),
      actorId: userId,
    });

    await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
      vaultId: vault.id,
      itemId: item.id,
      actorId: userId,
      action: 'item.created',
      targetLabel: item.title,
      metadata: { type: item.type },
    });

    return success(c, item, 201);
  },
);

app.post(
  `${VAULT}/items/import`,
  requirePermission('passwords:use'),
  zValidator('json', importItemsSchema),
  async (c) => {
    const { db, userId, access, vault } = await vaultFor(c);
    assertVaultRole(access, 'editor');
    const body = c.req.valid('json');

    const parsed = parseImport(body.content, body.format);
    if (parsed.documents.length === 0) {
      return error.badRequest(c, 'Nothing to import was found in that file.', {
        skipped: parsed.skipped,
      });
    }

    const kek = await openPasswordVault(db, keyring(c), vault.id);
    const created = await createItems(db, kek, {
      vaultId: vault.id,
      documents: parsed.documents,
      actorId: userId,
    });

    await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
      vaultId: vault.id,
      actorId: userId,
      action: 'items.imported',
      metadata: {
        format: parsed.format,
        created: created.length,
        skipped: parsed.skipped.length,
        warnings: parsed.warnings.length,
      },
    });

    return success(c, {
      format: parsed.format,
      created: created.length,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
    });
  },
);

/** Decrypt one item. Any member may; every call is written to the trail. */
app.get(`${ITEM}/reveal`, requirePermission('passwords:use'), async (c) => {
  const { db, userId, access, vault } = await vaultFor(c);
  assertVaultRole(access, 'viewer');

  const kek = await openPasswordVault(db, keyring(c), vault.id);
  const { item, document } = await revealItem(db, kek, vault.id, pathParam(c, 'itemId'));

  await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
    vaultId: vault.id,
    itemId: item.id,
    actorId: userId,
    action: 'item.revealed',
    targetLabel: item.title,
    // Lets a manager tell a person reading a password from the extension
    // filling a form. Client-supplied, so informational only.
    metadata: { client: c.req.header('X-WeldPass-Client')?.slice(0, 40) ?? 'web' },
  });

  return success(c, { ...item, fields: document.fields });
});

/** The current 2FA code. The seed itself stays in the vault. */
app.post(`${ITEM}/totp`, requirePermission('passwords:use'), async (c) => {
  const { db, userId, access, vault } = await vaultFor(c);
  assertVaultRole(access, 'viewer');

  const kek = await openPasswordVault(db, keyring(c), vault.id);
  const { item, totp } = await itemTotpCode(db, kek, vault.id, pathParam(c, 'itemId'));

  await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
    vaultId: vault.id,
    itemId: item.id,
    actorId: userId,
    action: 'item.totp_generated',
    targetLabel: item.title,
  });

  return success(c, totp);
});

app.put(
  ITEM,
  requirePermission('passwords:use'),
  zValidator('json', itemInputSchema),
  async (c) => {
    const { db, userId, access, vault } = await vaultFor(c);
    assertVaultRole(access, 'editor');

    const kek = await openPasswordVault(db, keyring(c), vault.id);
    const result = await updateItem(db, kek, {
      vaultId: vault.id,
      itemId: pathParam(c, 'itemId'),
      document: c.req.valid('json'),
      actorId: userId,
    });

    if (result.changed) {
      await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
        vaultId: vault.id,
        itemId: result.item.id,
        actorId: userId,
        action: 'item.updated',
        targetLabel: result.item.title,
        metadata: { passwordChanged: result.passwordChanged },
      });
    }

    return success(c, result.item);
  },
);

app.delete(ITEM, requirePermission('passwords:use'), async (c) => {
  const { db, userId, access, vault } = await vaultFor(c);
  assertVaultRole(access, 'editor');

  const item = await deleteItem(db, vault.id, pathParam(c, 'itemId'), userId);
  await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
    vaultId: vault.id,
    itemId: item.id,
    actorId: userId,
    action: 'item.deleted',
    targetLabel: item.title,
  });

  return noContent(c);
});

app.get(`${ITEM}/versions`, requirePermission('passwords:use'), async (c) => {
  const { db, access, vault } = await vaultFor(c);
  assertVaultRole(access, 'viewer');
  const item = await requireItem(db, vault.id, pathParam(c, 'itemId'));
  return success(c, await listItemVersions(db, item.id));
});

app.post(
  `${ITEM}/restore`,
  requirePermission('passwords:use'),
  zValidator('json', restoreItemSchema),
  async (c) => {
    const { db, userId, access, vault } = await vaultFor(c);
    assertVaultRole(access, 'editor');
    const { version } = c.req.valid('json');

    const kek = await openPasswordVault(db, keyring(c), vault.id);
    const result = await restoreItemVersion(db, kek, {
      vaultId: vault.id,
      itemId: pathParam(c, 'itemId'),
      version,
      actorId: userId,
    });

    await recordVaultEvent(db, auditContextFrom(c.req.raw.headers), {
      vaultId: vault.id,
      itemId: result.item.id,
      actorId: userId,
      action: 'item.restored',
      targetLabel: result.item.title,
      metadata: { restoredFrom: version, changed: result.changed },
    });

    return success(c, result.item);
  },
);

/**
 * Move an item to another vault — the way a private login becomes a shared
 * one. Takes editor on both ends: the source loses the item, the target gains
 * it, and both trails say so.
 */
app.post(
  `${ITEM}/move`,
  requirePermission('passwords:use'),
  zValidator('json', moveItemSchema),
  async (c) => {
    const { db, userId, access, vault } = await vaultFor(c);
    assertVaultRole(access, 'editor');
    const { targetVaultId } = c.req.valid('json');

    if (targetVaultId === vault.id) {
      return error.badRequest(c, 'The item is already in that vault.');
    }

    // Resolved without `passwords:manage`: moving into a vault is writing to
    // it, which takes membership like any other write.
    const target = await requireVaultAccess(db, c.get('workspaceId'), userId, targetVaultId);
    assertVaultRole(target, 'editor');

    const { source, moved } = await moveItem(
      db,
      {
        source: await openPasswordVault(db, keyring(c), vault.id),
        target: await openPasswordVault(db, keyring(c), target.vault.id),
      },
      {
        sourceVaultId: vault.id,
        targetVaultId: target.vault.id,
        itemId: pathParam(c, 'itemId'),
        actorId: userId,
      },
    );

    const context = auditContextFrom(c.req.raw.headers);
    await recordVaultEvent(db, context, {
      vaultId: vault.id,
      itemId: source.id,
      actorId: userId,
      action: 'item.moved_out',
      targetLabel: source.title,
      metadata: { toVaultId: target.vault.id },
    });
    await recordVaultEvent(db, context, {
      vaultId: target.vault.id,
      itemId: moved.id,
      actorId: userId,
      action: 'item.moved_in',
      targetLabel: moved.title,
      metadata: { fromVaultId: vault.id },
    });

    return success(c, moved);
  },
);

export { app as passwordRoutes };
