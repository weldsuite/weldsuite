/**
 * Mail account routes — /api/mail-accounts/*.
 *
 * Endpoints mirror the api-worker surface they replace (`/api/mail/accounts/*`).
 * Permissions follow the same shape: `accounts:*` for CRUD, `messages:create`
 * for the SEND endpoint (which is wired separately in mail-messages — this
 * file does not own send-from-account).
 *
 * Entity events: `mail_account:created | updated | deleted` (the catalog
 * lives at packages/core/entity-events/src/events/mail.ts).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission, getPermissionsFromContext } from '@weldsuite/permissions/server';
import {
  checkAccountAccess,
  checkAccountManageAccess,
  emailEventData,
} from '@weldsuite/mail-domain/access';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import * as accounts from '../../services/mail/accounts';
import { MailAccountError } from '../../services/mail/accounts';
import { MailSendError, sendAndPersist } from '@weldsuite/mail-domain/send';
import { sendErrorResponse } from '../../lib/send-errors';
import { MAILBOX_DAILY_SEND_LIMIT_MAX } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { resolveMailStoreMode, readsFromObject, writesObject } from '@weldsuite/mail-domain/store/mode';
import { bumpMailboxDirectory } from '@weldsuite/mail-domain/store/directory';
import { workspaceMailFromContext } from '../../lib/mail-store-context';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listQuery = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  provider: z.string().optional(),
  scope: z.enum(['manage']).optional(),
});

const providerEnum = z.enum([
  'gmail', 'outlook', 'office365', 'exchange', 'imap', 'yahoo',
  'mailcow', 'resend', 'smtp', 'cloudflare', 'custom',
]);

const createBody = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  displayName: z.string().max(255).optional(),
  provider: providerEnum.default('imap'),
  authType: z.enum(['oauth2', 'password', 'api_key']).default('password'),
  imapHost: z.string().max(255).optional(),
  imapPort: z.number().int().optional(),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.number().int().optional(),
  smtpSecure: z.boolean().default(true),
  syncEnabled: z.boolean().default(true),
  syncFrequency: z.number().int().default(5),
  signature: z.string().optional(),
  // A mailbox can lower its own daily limit, never raise it past the outbound
  // guard's ceiling (docs/plans/weldmail-outbound-abuse.md).
  dailySendLimit: z.number().int().min(1).max(MAILBOX_DAILY_SEND_LIMIT_MAX).default(500),
  isDefault: z.boolean().default(false),
  isShared: z.boolean().default(true),
  assignedUserIds: z.array(z.string()).optional(),
  aiSettings: z
    .object({
      customInstructions: z.string().max(2000).optional(),
      defaultTone: z.enum(['professional', 'friendly', 'casual']).optional(),
      defaultLength: z.enum(['short', 'medium', 'long']).optional(),
      modelPreference: z.string().max(100).optional(),
    })
    .optional(),
});

const updateBody = createBody.partial();

const assignUsersBody = z.object({
  isShared: z.boolean(),
  assignedUserIds: z.array(z.string()).default([]),
});

const sendAttachmentSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().nonnegative(),
  fileKey: z.string().min(1),
});

const sendBody = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().optional().default('(No subject)'),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyTo: z.string().email().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  attachments: z.array(sendAttachmentSchema).optional(),
  // Client-generated key; a replayed send with the same key returns the
  // already-sent message instead of sending twice (offline queue / retries).
  idempotencyKey: z.string().min(1).max(64).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the caller is an owner/admin, from the permissions `requirePermission`
 * already resolved for this request (design §6: "isAdmin = ...role, already
 * resolved by requirePermission") — never a fresh tenant-DB lookup, which is
 * exactly what object-mode directory reads exist to avoid.
 */
function isAdminFromContext(c: Context<{ Bindings: Env; Variables: Variables }>): boolean {
  const perms = getPermissionsFromContext(c);
  return !!perms && (perms.isOwner || perms.role.toUpperCase() === 'ADMIN');
}

/** Map a MailAccountError to its HTTP status code. */
function mapMailAccountError(c: Parameters<typeof error.badRequest>[0], err: MailAccountError) {
  switch (err.code) {
    case 'BARE_WELDMAIL_DOMAIN_BLOCKED':
    case 'INVALID_USER_IDS':
      return error.badRequest(c, err.message, err.details);
    case 'WRONG_WELDMAIL_SUBDOMAIN':
    case 'FORBIDDEN':
      return error.forbidden(c, err.message);
    case 'DUPLICATE_EMAIL':
      return error.conflict(c, err.message);
    case 'DOMAIN_NOT_IN_WELDHOST':
      return error.badRequest(c, err.message);
    // 409 with its own code rather than error.conflict(), which flattens every
    // conflict to code 'CONFLICT' — the setup dialog branches on this code to
    // explain the one-inbound-provider rule instead of a generic failure toast.
    case 'DOMAIN_HAS_EXISTING_MX':
      return c.json(
        { error: { code: 'DOMAIN_HAS_EXISTING_MX', message: err.message, details: err.details } },
        409,
      );
    case 'NOT_FOUND':
      return error.notFound(c, 'Mail account');
    case 'CLOUDFLARE_PROVISION_FAILED':
      return c.json(
        { error: { code: 'CLOUDFLARE_PROVISION_FAILED', message: err.message, details: err.details } },
        502,
      );
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', requirePermission('accounts:read'), zValidator('query', listQuery), async (c) => {
  try {
    const filters = c.req.valid('query');
    const workspaceId = c.get('workspaceId');
    const mode = await resolveMailStoreMode(c.env, workspaceId);
    // Two separate `list(...)` calls (not a ternary feeding one shared `result`)
    // so TypeScript infers each branch's row shape on its own — a `DirectoryAccount`
    // (date columns as ISO strings) and a Postgres row (date columns as `Date`)
    // serialise to the identical JSON, but don't unify as one array type.
    if (readsFromObject(mode)) {
      const access = await accounts.buildDirectoryMailAccess(
        c.env,
        c.get('tenantDb'),
        workspaceId,
        c.get('userId'),
        isAdminFromContext(c),
      );
      const result = await accounts.listMailAccountsFromDirectory(access, filters);
      return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
    }
    const result = await accounts.listMailAccounts(c.get('tenantDb'), c.get('userId'), filters);
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/mail-accounts] list failed:', err);
    return error.internal(c, 'Failed to list mail accounts');
  }
});

app.get('/stats', requirePermission('accounts:read'), async (c) => {
  try {
    const stats = await accounts.getMailAccountStats(c.get('tenantDb'));
    return success(c, stats);
  } catch (err) {
    console.error('[app-api/mail-accounts] stats failed:', err);
    return error.internal(c, 'Failed to fetch mail account stats');
  }
});

/** Static system-label catalogue for the setup wizard. No DB hit needed. */
app.get('/setup/labels', requirePermission('accounts:read'), (c) =>
  success(c, [
    { id: 'INBOX', name: 'Inbox', type: 'system' },
    { id: 'SENT', name: 'Sent', type: 'system' },
    { id: 'DRAFTS', name: 'Drafts', type: 'system' },
    { id: 'TRASH', name: 'Trash', type: 'system' },
    { id: 'SPAM', name: 'Spam', type: 'system' },
    { id: 'STARRED', name: 'Starred', type: 'system' },
    { id: 'IMPORTANT', name: 'Important', type: 'system' },
    { id: 'ARCHIVE', name: 'Archive', type: 'system' },
    { id: 'PROMOTIONS', name: 'Promotions', type: 'system' },
  ]),
);

app.get('/:id/labels', requirePermission('accounts:read'), async (c) => {
  try {
    const id = c.req.param('id');
    const workspaceId = c.get('workspaceId');
    const mode = await resolveMailStoreMode(c.env, workspaceId);
    if (readsFromObject(mode)) {
      const access = await accounts.buildDirectoryMailAccess(
        c.env,
        c.get('tenantDb'),
        workspaceId,
        c.get('userId'),
        isAdminFromContext(c),
      );
      const labels = await accounts.getMailAccountLabelsFromDirectory(access, id);
      if (labels === null) return error.notFound(c, 'Mail account', id);
      return success(c, labels);
    }
    if (!(await checkAccountAccess(c.get('tenantDb'), id, c.get('userId')))) {
      return error.notFound(c, 'Mail account', id);
    }
    const labels = await accounts.getMailAccountLabels(c.get('tenantDb'), id);
    if (labels === null) return error.notFound(c, 'Mail account', id);
    return success(c, labels);
  } catch (err) {
    console.error('[app-api/mail-accounts] labels failed:', err);
    return error.internal(c, 'Failed to fetch mail account labels');
  }
});

app.get('/:id', requirePermission('accounts:read'), async (c) => {
  try {
    const id = c.req.param('id');
    const workspaceId = c.get('workspaceId');
    const mode = await resolveMailStoreMode(c.env, workspaceId);
    if (readsFromObject(mode)) {
      const access = await accounts.buildDirectoryMailAccess(
        c.env,
        c.get('tenantDb'),
        workspaceId,
        c.get('userId'),
        isAdminFromContext(c),
      );
      const row = await accounts.getMailAccountFromDirectory(access, id);
      if (!row) return error.notFound(c, 'Mail account', id);
      return success(c, row);
    }
    const row = await accounts.getMailAccount(c.get('tenantDb'), id, c.get('userId'));
    if (!row) return error.notFound(c, 'Mail account', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-accounts] get failed:', err);
    return error.internal(c, 'Failed to fetch mail account');
  }
});

app.post('/', requirePermission('accounts:create'), zValidator('json', createBody), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const data = c.req.valid('json');
  try {
    const row = await accounts.createMailAccount(
      c.env,
      c.get('tenantDb'),
      orgId,
      c.get('userId'),
      data,
    );
    c.executionCtx.waitUntil(bumpMailboxDirectory(c.env, c.get('workspaceId')));
    publishEntityEvent({
      c,
      entityType: 'mail_account',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, email: row.email, provider: data.provider, status: 'active' },
    });
    return success(c, row, 201);
  } catch (err) {
    if (err instanceof MailAccountError) return mapMailAccountError(c, err);
    console.error('[app-api/mail-accounts] create failed:', err);
    return error.internal(c, 'Failed to create mail account');
  }
});

// PUT and PATCH share an identical body — same validator, same handler.
// Keeping both verbs registered preserves wire compatibility with the
// legacy api-worker surface (the frontend uses both interchangeably).
const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }, '/:id'>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  // Row-level guard: only admins/owners, or users the account is shared with /
  // assigned to, may edit it. Without this any `accounts:update` holder could
  // edit a private account's config (incl. isShared/assignedUserIds → self-grant).
  // Managing is not reading: an admin can edit a private mailbox's settings
  // without being able to open it.
  if (!(await checkAccountManageAccess(c.get('tenantDb'), id, c.get('userId')))) {
    return error.notFound(c, 'Mail account', id);
  }
  try {
    const result = await accounts.updateMailAccount(c.get('tenantDb'), id, data);
    if (!result) return error.notFound(c, 'Mail account', id);
    c.executionCtx.waitUntil(bumpMailboxDirectory(c.env, c.get('workspaceId')));
    publishEntityEvent({
      c,
      entityType: 'mail_account',
      entityId: id,
      action: 'updated',
      data: {
        id,
        email: result.after.email,
        provider: result.after.provider,
        status: result.after.status,
      },
    });
    return success(c, { id, ...data });
  } catch (err) {
    console.error('[app-api/mail-accounts] update failed:', err);
    return error.internal(c, 'Failed to update mail account');
  }
};

app.put('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);

app.patch('/:id/sync', requirePermission('accounts:update'), async (c) => {
  try {
    const result = await accounts.triggerAccountSync(c.get('tenantDb'), c.req.param('id'), c.get('userId'));
    if (!result) return error.notFound(c, 'Mail account', c.req.param('id'));
    c.executionCtx.waitUntil(bumpMailboxDirectory(c.env, c.get('workspaceId')));
    return success(c, result);
  } catch (err) {
    console.error('[app-api/mail-accounts] sync trigger failed:', err);
    return error.internal(c, 'Failed to trigger sync');
  }
});

app.patch(
  '/:id/assign-users',
  requirePermission('accounts:update'),
  zValidator('json', assignUsersBody),
  async (c) => {
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const result = await accounts.assignMailAccountUsers(
        c.get('tenantDb'),
        id,
        c.get('userId'),
        data.isShared,
        data.assignedUserIds,
      );
      c.executionCtx.waitUntil(bumpMailboxDirectory(c.env, c.get('workspaceId')));
      // The catalog payload (id/email/provider/status) is just an identity
      // breadcrumb — the actual assignment delta lives on the response,
      // not the entity event. Consumers that care about the new
      // isShared / assignedUserIds re-fetch the account.
      publishEntityEvent({
        c,
        entityType: 'mail_account',
        entityId: id,
        action: 'updated',
        data: {
          id,
          email: result.email,
          provider: result.provider,
          status: result.status,
        },
      });
      return success(c, {
        id: result.id,
        isShared: result.isShared,
        assignedUserIds: result.assignedUserIds ?? [],
      });
    } catch (err) {
      if (err instanceof MailAccountError) return mapMailAccountError(c, err);
      console.error('[app-api/mail-accounts] assign-users failed:', err);
      return error.internal(c, 'Failed to assign users');
    }
  },
);

/**
 * POST /:id/send — compose and send a new email from this account via the
 * Cloudflare `[[send_email]]` binding. Persists a SENT copy on the account.
 */
app.post(
  '/:id/send',
  requirePermission('messages:create'),
  zValidator('json', sendBody),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const accountId = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const { store, mode } = await workspaceMailFromContext(c);
      const result = await sendAndPersist(
        c.env,
        c.get('tenantDb'),
        orgId,
        c.get('userId'),
        accountId,
        data,
        {
          waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
          store: store.mailbox(accountId),
          mailStoreMode: mode,
        },
      );
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: result.messageId,
        action: 'email_sent',
        data: await emailEventData(c.get('tenantDb'), {
          id: result.messageId,
          accountId: result.accountId,
          subject: result.subject,
          from: null,
          to: data.to,
        }),
      });
      return success(c, {
        messageId: result.messageId,
        smtpMessageId: result.smtpMessageId,
        pendingVerification: result.pendingVerification,
        message: result.pendingVerification
          ? 'Send is pending recipient verification'
          : 'Email sent successfully',
      });
    } catch (err) {
      if (err instanceof MailSendError) return sendErrorResponse(c, err, { resource: 'Mail account' });
      console.error('[app-api/mail-accounts] send failed:', err);
      return error.internal(c, 'Failed to send email');
    }
  },
);

app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const result = await accounts.deleteMailAccount(c.env, c.get('tenantDb'), id, c.get('userId'));
    if (!result.found) return error.notFound(c, 'Mail account', id);

    const workspaceId = c.get('workspaceId');
    c.executionCtx.waitUntil(bumpMailboxDirectory(c.env, workspaceId));

    // Any mode that may have written the mailbox object (shadow and above)
    // also tears it down and drops it from the MailIndex — best-effort,
    // never failing this request (design §9 task D3).
    const mode = await resolveMailStoreMode(c.env, workspaceId);
    if (writesObject(mode)) {
      c.executionCtx.waitUntil(
        accounts.destroyMailboxObject(c.env, {
          workspaceId,
          accountId: id,
          clerkOrgId: c.get('clerkOrgId'),
        }),
      );
    }

    publishEntityEvent({
      c,
      entityType: 'mail_account',
      entityId: id,
      action: 'deleted',
      data: {
        id,
        email: result.account.email,
        provider: result.account.provider,
        status: result.account.status,
      },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-accounts] delete failed:', err);
    return error.internal(c, 'Failed to delete mail account');
  }
});

export const mailAccountsRoutes = app;
