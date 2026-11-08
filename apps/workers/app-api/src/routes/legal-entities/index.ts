/**
 * Legal entities routes: /api/legal-entities/*. The companies of the workspace,
 * shared by WeldBooks and WeldHR, with their registrations, bank accounts and
 * per-entity access. docs/plans/legal-entities.md.
 *
 *   GET    /                                       list what the member sees  [legal_entities:read]
 *   GET    /default                                the default entity or null [read]
 *   GET    /:id, /:id/usage                                                   [read]
 *   POST   /                                       create                     [create]
 *   PATCH  /:id                                    update                     [update]
 *   POST   /:id/make-default | archive | unarchive                            [update]
 *   DELETE /:id                                    soft delete (204)          [delete]
 *   GET    /:id/registrations                                                 [read]
 *   POST|PATCH|DELETE /:id/registrations[/:registrationId]                    [update]
 *   GET    /:id/bank-accounts                                                 [read]
 *   POST|PATCH|DELETE /:id/bank-accounts[/:accountId]                         [update]
 *   POST   /:id/bank-accounts/:accountId/reveal    full account number        [reveal]
 *   GET    /:id/access, PATCH /:id/access                                     [manage]
 *   PUT|DELETE /:id/access/members/:userId                                    [manage]
 *   GET    /:id/my-access                          the caller's role here     [authenticated]
 *
 * An entity the member does not see answers 404 on every route. Owners and
 * `legal_entities:manage` holders see all. Registrations, make-default,
 * unarchive and the restricted switch publish `legal_entity` `updated`.
 * A reveal publishes no event: it is logged in `tax_id_reveals`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createBankAccountSchema,
  createLegalEntitySchema,
  createRegistrationSchema,
  listLegalEntitiesQuerySchema,
  revealBankAccountSchema,
  setEntityMemberSchema,
  updateBankAccountSchema,
  updateEntityAccessSchema,
  updateLegalEntitySchema,
  updateRegistrationSchema,
} from '@weldsuite/app-api-client/schemas/legal-entities';
import {
  LegalEntityError,
  canSeeEntity,
  createBankAccount,
  createLegalEntity,
  createRegistration,
  deleteBankAccount,
  deleteLegalEntity,
  deleteRegistration,
  getDefaultLegalEntity,
  getEntityAccess,
  getEntityAccessList,
  getLegalEntity,
  legalEntityUsage,
  listBankAccounts,
  listLegalEntities,
  listRegistrations,
  loadEntityAccess,
  myEffectiveAccess,
  removeEntityMember,
  revealBankAccountNumber,
  setDefaultLegalEntity,
  setEntityMember,
  setEntityRestricted,
  setLegalEntityArchived,
  updateBankAccount,
  updateLegalEntity,
  updateRegistration,
} from '@weldsuite/core-domain/legal-entities';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { mirrorStripeCustomer } from '../../services/workspace-settings';
import { stripeProfileFromEntity } from '../../services/business-profile';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const asData = (value: unknown) => value as Record<string, unknown>;

/** Map a service error to the house error envelope; anything else is rethrown. */
function failure(c: Ctx, err: unknown) {
  if (err instanceof LegalEntityError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return error.notFound(c, 'Legal entity');
      case 'CONFLICT':
        return error.conflict(c, err.message);
      case 'BAD_REQUEST':
        return error.badRequest(c, err.message);
      case 'NO_ENCRYPTION_KEY':
        return error.internal(c, 'Encryption is not configured');
    }
  }
  throw err;
}

/** Whether the member sees the entity (unknown and hidden look the same). */
async function seesEntity(c: Ctx, id: string): Promise<boolean> {
  return canSeeEntity(await getEntityAccess(c), id);
}

/** The entity as the caller now sees it, from a fresh access snapshot (the one on the request predates this write). */
async function entityView(c: Ctx, id: string) {
  const db = c.get('tenantDb');
  const access = await loadEntityAccess(db, c.get('userId'), (await getEntityAccess(c)).workspacePermissions);
  return getLegalEntity(db, id, access);
}

/** Publish `legal_entity` `updated` (or `archived`) with the entity as it is now. */
async function publishEntityUpdated(c: Ctx, id: string, action: 'updated' | 'archived' = 'updated') {
  const entity = await getLegalEntity(c.get('tenantDb'), id);
  publishEntityEvent({ c, entityType: 'legal_entity', action, entityId: id, data: asData(entity ?? { id }) });
}

/** The default entity is the workspace business profile: keep the Stripe customer in step with it. */
async function mirrorDefaultToStripe(c: Ctx, entity: Parameters<typeof stripeProfileFromEntity>[0]) {
  if (!entity.isDefault || !c.env.STRIPE_SECRET_KEY) return;
  await mirrorStripeCustomer({
    masterDb: getMasterDb(c.env),
    workspaceRef: c.get('workspaceId'),
    profile: stripeProfileFromEntity(entity),
    stripeSecretKey: c.env.STRIPE_SECRET_KEY,
  });
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

app.get('/', requirePermission('legal_entities:read'), zValidator('query', listLegalEntitiesQuerySchema), async (c) => {
  const { app: forApp, includeArchived } = c.req.valid('query');
  const entities = await listLegalEntities(c.get('tenantDb'), {
    access: await getEntityAccess(c),
    app: forApp,
    includeArchived: includeArchived === 'true',
  });
  return success(c, entities);
});

// Before /:id so the literal segment wins.
app.get('/default', requirePermission('legal_entities:read'), async (c) => {
  const entity = await getDefaultLegalEntity(c.get('tenantDb'), await getEntityAccess(c));
  return success(c, entity);
});

app.get('/:id', requirePermission('legal_entities:read'), async (c) => {
  const id = c.req.param('id');
  const entity = await getLegalEntity(c.get('tenantDb'), id, await getEntityAccess(c));
  if (!entity) return error.notFound(c, 'Legal entity');
  return success(c, entity);
});

app.get('/:id/usage', requirePermission('legal_entities:read'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    return success(c, await legalEntityUsage(c.get('tenantDb'), id));
  } catch (err) {
    return failure(c, err);
  }
});

app.post('/', requirePermission('legal_entities:create'), zValidator('json', createLegalEntitySchema), async (c) => {
  try {
    const row = await createLegalEntity(c.get('tenantDb'), c.req.valid('json'));
    const entity = await entityView(c, row.id);
    publishEntityEvent({ c, entityType: 'legal_entity', action: 'created', entityId: row.id, data: asData(entity ?? row) });
    await mirrorDefaultToStripe(c, row);
    return success(c, entity, 201);
  } catch (err) {
    return failure(c, err);
  }
});

app.patch('/:id', requirePermission('legal_entities:update'), zValidator('json', updateLegalEntitySchema), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    const row = await updateLegalEntity(c.get('tenantDb'), id, c.req.valid('json'));
    const entity = await entityView(c, id);
    publishEntityEvent({ c, entityType: 'legal_entity', action: 'updated', entityId: id, data: asData(entity ?? row) });
    await mirrorDefaultToStripe(c, row);
    return success(c, entity);
  } catch (err) {
    return failure(c, err);
  }
});

app.post('/:id/make-default', requirePermission('legal_entities:update'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    const row = await setDefaultLegalEntity(c.get('tenantDb'), id);
    await publishEntityUpdated(c, id);
    await mirrorDefaultToStripe(c, row);
    return success(c, await entityView(c, id));
  } catch (err) {
    return failure(c, err);
  }
});

app.post('/:id/archive', requirePermission('legal_entities:update'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    await setLegalEntityArchived(c.get('tenantDb'), id, true);
    await publishEntityUpdated(c, id, 'archived');
    return success(c, await entityView(c, id));
  } catch (err) {
    return failure(c, err);
  }
});

app.post('/:id/unarchive', requirePermission('legal_entities:update'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    await setLegalEntityArchived(c.get('tenantDb'), id, false);
    await publishEntityUpdated(c, id);
    return success(c, await entityView(c, id));
  } catch (err) {
    return failure(c, err);
  }
});

app.delete('/:id', requirePermission('legal_entities:delete'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    const before = await getLegalEntity(c.get('tenantDb'), id);
    const row = await deleteLegalEntity(c.get('tenantDb'), id);
    publishEntityEvent({ c, entityType: 'legal_entity', action: 'deleted', entityId: id, data: asData(before ?? row) });
    return noContent(c);
  } catch (err) {
    return failure(c, err);
  }
});

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

app.get('/:id/registrations', requirePermission('legal_entities:read'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  return success(c, await listRegistrations(c.get('tenantDb'), id));
});

app.post('/:id/registrations', requirePermission('legal_entities:update'), zValidator('json', createRegistrationSchema), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    const registration = await createRegistration(c.get('tenantDb'), id, c.req.valid('json'));
    await publishEntityUpdated(c, id);
    return success(c, registration, 201);
  } catch (err) {
    return failure(c, err);
  }
});

app.patch(
  '/:id/registrations/:registrationId',
  requirePermission('legal_entities:update'),
  zValidator('json', updateRegistrationSchema),
  async (c) => {
    const id = c.req.param('id');
    if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
    try {
      const registration = await updateRegistration(c.get('tenantDb'), id, c.req.param('registrationId'), c.req.valid('json'));
      await publishEntityUpdated(c, id);
      return success(c, registration);
    } catch (err) {
      return failure(c, err);
    }
  },
);

app.delete('/:id/registrations/:registrationId', requirePermission('legal_entities:update'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    await deleteRegistration(c.get('tenantDb'), id, c.req.param('registrationId'));
    await publishEntityUpdated(c, id);
    return noContent(c);
  } catch (err) {
    return failure(c, err);
  }
});

// ---------------------------------------------------------------------------
// Bank accounts (events carry the public shape, never the encrypted number)
// ---------------------------------------------------------------------------

app.get('/:id/bank-accounts', requirePermission('legal_entities:read'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  return success(c, await listBankAccounts(c.get('tenantDb'), id));
});

app.post('/:id/bank-accounts', requirePermission('legal_entities:update'), zValidator('json', createBankAccountSchema), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    const account = await createBankAccount(c.get('tenantDb'), c.env, id, c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'legal_entity_bank_account', action: 'created', entityId: account.id, data: asData(account) });
    return success(c, account, 201);
  } catch (err) {
    return failure(c, err);
  }
});

app.patch(
  '/:id/bank-accounts/:accountId',
  requirePermission('legal_entities:update'),
  zValidator('json', updateBankAccountSchema),
  async (c) => {
    const id = c.req.param('id');
    if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
    try {
      const account = await updateBankAccount(c.get('tenantDb'), c.env, id, c.req.param('accountId'), c.req.valid('json'));
      publishEntityEvent({ c, entityType: 'legal_entity_bank_account', action: 'updated', entityId: account.id, data: asData(account) });
      return success(c, account);
    } catch (err) {
      return failure(c, err);
    }
  },
);

app.delete('/:id/bank-accounts/:accountId', requirePermission('legal_entities:update'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  const accountId = c.req.param('accountId');
  try {
    const existing = (await listBankAccounts(c.get('tenantDb'), id)).find((a) => a.id === accountId);
    await deleteBankAccount(c.get('tenantDb'), id, accountId);
    publishEntityEvent({
      c,
      entityType: 'legal_entity_bank_account',
      action: 'deleted',
      entityId: accountId,
      data: asData(existing ?? { id: accountId, entityId: id }),
    });
    return noContent(c);
  } catch (err) {
    return failure(c, err);
  }
});

// Logged in `tax_id_reveals` by the service; no entity event.
app.post('/:id/bank-accounts/:accountId/reveal', requirePermission('legal_entities:reveal'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  const body = revealBankAccountSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return error.badRequest(c, 'Invalid request', body.error.flatten());
  try {
    const revealed = await revealBankAccountNumber(c.get('tenantDb'), c.env, {
      entityId: id,
      accountId: c.req.param('accountId'),
      userId: c.get('userId'),
      reason: body.data.reason ?? null,
    });
    return success(c, revealed);
  } catch (err) {
    return failure(c, err);
  }
});

// ---------------------------------------------------------------------------
// Per-entity access
// ---------------------------------------------------------------------------

app.get('/:id/access', requirePermission('legal_entities:manage'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    return success(c, await getEntityAccessList(c.get('tenantDb'), id));
  } catch (err) {
    return failure(c, err);
  }
});

app.patch('/:id/access', requirePermission('legal_entities:manage'), zValidator('json', updateEntityAccessSchema), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  try {
    await setEntityRestricted(c.get('tenantDb'), id, c.req.valid('json').restricted);
    await publishEntityUpdated(c, id);
    return success(c, await getEntityAccessList(c.get('tenantDb'), id));
  } catch (err) {
    return failure(c, err);
  }
});

app.put(
  '/:id/access/members/:userId',
  requirePermission('legal_entities:manage'),
  zValidator('json', setEntityMemberSchema),
  async (c) => {
    const id = c.req.param('id');
    if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
    const userId = c.req.param('userId');
    const { roleId } = c.req.valid('json');
    try {
      const { created, member } = await setEntityMember(c.get('tenantDb'), {
        entityId: id,
        userId,
        roleId,
        grantedBy: c.get('userId'),
      });
      publishEntityEvent({
        c,
        entityType: 'legal_entity_member',
        action: created ? 'created' : 'updated',
        entityId: member.id,
        data: { entityId: id, userId, roleId: member.roleId ?? null },
      });
      const list = await getEntityAccessList(c.get('tenantDb'), id);
      return success(c, list.members.find((m) => m.userId === userId), created ? 201 : 200);
    } catch (err) {
      return failure(c, err);
    }
  },
);

app.delete('/:id/access/members/:userId', requirePermission('legal_entities:manage'), async (c) => {
  const id = c.req.param('id');
  if (!(await seesEntity(c, id))) return error.notFound(c, 'Legal entity');
  const userId = c.req.param('userId');
  const removed = await removeEntityMember(c.get('tenantDb'), id, userId);
  if (!removed) return error.notFound(c, 'Member');
  publishEntityEvent({
    c,
    entityType: 'legal_entity_member',
    action: 'deleted',
    entityId: removed.id,
    data: { entityId: id, userId, roleId: removed.roleId ?? null },
  });
  return noContent(c);
});

// The caller's own role and permissions in this entity: authentication only.
app.get('/:id/my-access', async (c) => {
  const id = c.req.param('id');
  const access = await myEffectiveAccess(c.get('tenantDb'), await getEntityAccess(c), id);
  if (!access) return error.notFound(c, 'Legal entity');
  return success(c, access);
});

export { app as legalEntitiesRoutes };
