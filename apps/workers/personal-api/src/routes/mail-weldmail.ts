/**
 * Personal WeldMail — addresses on weldmail.com (max 1 per personal account).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { getMasterDb, getPersonalDb, masterSchema, personalSchema } from '../db';
import { generateId } from '../lib/id';
import { error, success } from '../lib/response';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const WELDMAIL_DOMAIN = 'weldmail.com';

/** Addresses reserved at the platform level — can never be claimed. */
const RESERVED_ADDRESSES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'support', 'help', 'info', 'contact',
  'sales', 'billing', 'noreply', 'no-reply', 'postmaster', 'hostmaster',
  'webmaster', 'abuse', 'security', 'mailer-daemon', 'root', 'system',
  'mail', 'email', 'test', 'dev', 'staging', 'prod', 'production',
  'api', 'www', 'ftp', 'smtp', 'imap', 'pop',
  'weld', 'weldsuite', 'weldmail',
]);

const SYSTEM_LABEL_SEEDS = [
  { name: 'Inbox', slug: 'INBOX' },
  { name: 'Sent', slug: 'SENT' },
  { name: 'Drafts', slug: 'DRAFTS' },
  { name: 'Trash', slug: 'TRASH' },
  { name: 'Spam', slug: 'SPAM' },
  { name: 'Starred', slug: 'STARRED' },
] as const;

const addressSchema = z
  .string()
  .min(3, 'Address must be at least 3 characters')
  .max(64, 'Address must be at most 64 characters')
  .regex(
    /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/i,
    'Address can only contain letters, numbers, dots, hyphens, and underscores',
  )
  .transform((v) => v.toLowerCase());

const checkBody = z.object({ address: addressSchema });
const reserveBody = z.object({
  address: addressSchema,
  name: z.string().min(1).max(255).optional(),
  displayName: z.string().max(255).optional(),
});

app.get('/domain', (c) => success(c, { domain: WELDMAIL_DOMAIN }));

app.post('/check', zValidator('json', checkBody), async (c) => {
  const { address } = c.req.valid('json');

  if (RESERVED_ADDRESSES.has(address)) {
    return success(c, { available: false, reason: 'reserved' as const });
  }

  const email = `${address}@${WELDMAIL_DOMAIN}`;

  try {
    const masterDb = getMasterDb(c.env);
    const [existing] = await masterDb
      .select({ id: masterSchema.mailAccountRegistry.id })
      .from(masterSchema.mailAccountRegistry)
      .where(eq(masterSchema.mailAccountRegistry.email, email))
      .limit(1);

    if (existing) {
      return success(c, { available: false, reason: 'taken' as const });
    }

    return success(c, { available: true as const, email, domain: WELDMAIL_DOMAIN });
  } catch (err) {
    console.error('[personal-api/mail-weldmail] check failed:', err);
    return error.internal(c, 'Failed to check address');
  }
});

app.post('/reserve', zValidator('json', reserveBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const data = c.req.valid('json');

  if (RESERVED_ADDRESSES.has(data.address)) {
    return error.badRequest(c, 'This address is reserved');
  }

  const email = `${data.address}@${WELDMAIL_DOMAIN}`;

  try {
    const personalDb = getPersonalDb(c.env);
    const masterDb = getMasterDb(c.env);

    const existingAccounts = await personalDb
      .select({ id: personalSchema.personalMailAccounts.id })
      .from(personalSchema.personalMailAccounts)
      .where(
        and(
          eq(personalSchema.personalMailAccounts.personalAccountId, personalAccountId),
          isNull(personalSchema.personalMailAccounts.deletedAt),
        ),
      );

    const entitlements = c.get('entitlements');
    if (existingAccounts.length >= entitlements.maxAddresses) {
      return error.planLimit(
        c,
        `Your plan allows ${entitlements.maxAddresses} WeldMail address(es). Upgrade to Pro for more.`,
        { plan: entitlements.plan, maxAddresses: entitlements.maxAddresses },
      );
    }

    const [taken] = await masterDb
      .select({ id: masterSchema.mailAccountRegistry.id })
      .from(masterSchema.mailAccountRegistry)
      .where(eq(masterSchema.mailAccountRegistry.email, email))
      .limit(1);

    if (taken) {
      return error.conflict(c, 'This address is already taken');
    }

    const accountId = generateId('mail');
    const now = new Date();

    const [account] = await personalDb
      .insert(personalSchema.personalMailAccounts)
      .values({
        id: accountId,
        personalAccountId,
        name: data.name || data.address,
        email,
        displayName: data.displayName || data.name || data.address,
        provider: 'weldmail',
        status: 'active',
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await personalDb.insert(personalSchema.personalMailLabels).values(
      SYSTEM_LABEL_SEEDS.map((label, index) => ({
        id: generateId('label'),
        personalAccountId,
        accountId,
        name: label.name,
        slug: label.slug,
        isSystem: true,
        messageCount: 0,
        position: index,
        createdAt: now,
        updatedAt: now,
      })),
    );

    await masterDb.insert(masterSchema.mailAccountRegistry).values({
      id: generateId('reg'),
      email,
      tenantKind: 'personal',
      personalAccountId,
      workspaceId: null,
      accountId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    return success(
      c,
      {
        id: account!.id,
        email: account!.email,
        name: account!.name,
        displayName: account!.displayName,
        isDefault: account!.isDefault,
      },
      201,
    );
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      return error.conflict(c, 'This address is already taken');
    }
    console.error('[personal-api/mail-weldmail] reserve failed:', err);
    return error.internal(c, 'Failed to reserve address');
  }
});

export const mailWeldMailRoutes = app;
