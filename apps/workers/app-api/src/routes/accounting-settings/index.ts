/**
 * Accounting settings routes — /api/accounting-settings/* surface.
 * Singleton workspace-wide config stored in `settings`.
 *
 * Entity-specific identity (company details, tax IDs, numbering, branding,
 * jurisdiction filing credentials) lives on the `accounting_entities` table
 * — use /api/accounting-entities for those.
 *
 * The legacy api-worker POST /seed endpoint was deprecated (replaced by
 * POST /api/accounting-entities with seedDefaults=true) and is NOT ported.
 *
 * Permissions: accounts:read | accounts:update | accounts:create.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  updateAccountingSettingsSchema,
  registerInboxSchema,
} from '@weldsuite/app-api-client/schemas/accounting-settings';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, masterSchema, schema } from '../../db';
import {
  getExchangeRate,
  getExchangeRates,
  SUPPORTED_CURRENCIES,
} from '../../services/accounting-currency';
import { writeAccountingAudit } from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.settings;

// ---------------------------------------------------------------------------
// GET / — get or auto-create default settings (singleton)
// ---------------------------------------------------------------------------
app.get('/', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const [row] = await db.select().from(t).where(isNull(t.deletedAt)).limit(1);
    if (row) return success(c, row);

    // Auto-create default settings on first access.
    const id = generateId('acs');
    const now = new Date();
    const newSettings = { id, createdAt: now, updatedAt: now };
    await db.insert(t).values(newSettings as unknown as typeof t.$inferInsert);
    return success(c, newSettings, 201);
  } catch (err) {
    console.error('[app-api/accounting-settings] get failed:', err);
    return error.internal(c, 'Failed to fetch accounting settings');
  }
});

// ---------------------------------------------------------------------------
// PUT / + PATCH / — upsert settings (singleton — no /:id).
// Legacy api-worker exposed PUT; PATCH is the app-api convention. Both
// accept the same partial payload and share one handler.
// ---------------------------------------------------------------------------
app.on(
  ['PUT', 'PATCH'],
  '/',
  requirePermission('accounts:update'),
  zValidator('json', updateAccountingSettingsSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json') as Record<string, any>;
    try {
      const [existing] = await db.select().from(t).where(isNull(t.deletedAt)).limit(1);

      if (!existing) {
        // No settings row yet — create one.
        const id = generateId('acs');
        const now = new Date();
        const newSettings = { id, ...data, createdAt: now, updatedAt: now };
        await db.insert(t).values(newSettings as unknown as typeof t.$inferInsert);

        await writeAccountingAudit(c, db, {
          accountingEntityId: (data.defaultEntityId as string | undefined) ?? null,
          entityType: 'accounting_settings',
          entityId: id,
          action: 'updated',
        });
        publishEntityEvent({
          c,
          entityType: 'accounting_settings',
          entityId: id,
          action: 'updated',
          data: newSettings,
        });
        return success(c, newSettings, 201);
      }

      await db
        .update(t)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(t.id, existing.id));

      await writeAccountingAudit(c, db, {
        accountingEntityId:
          (data.defaultEntityId as string | undefined) ?? existing.defaultEntityId ?? null,
        entityType: 'accounting_settings',
        entityId: existing.id,
        action: 'updated',
        changes: Object.fromEntries(
          Object.entries(data)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, { old: (existing as Record<string, unknown>)[k], new: v }]),
        ),
      });
      publishEntityEvent({
        c,
        entityType: 'accounting_settings',
        entityId: existing.id,
        action: 'updated',
        data: { ...existing, ...data },
      });
      return success(c, { ...existing, ...data });
    } catch (err) {
      console.error('[app-api/accounting-settings] update failed:', err);
      return error.internal(c, 'Failed to update accounting settings');
    }
  },
);

// ---------------------------------------------------------------------------
// GET /exchange-rates — current exchange rate snapshot
// ---------------------------------------------------------------------------
app.get('/exchange-rates', requirePermission('accounts:read'), async (c) => {
  try {
    const rates = await getExchangeRates();
    return success(c, {
      rates,
      currencies: SUPPORTED_CURRENCIES,
      baseCurrency: 'EUR',
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[app-api/accounting-settings] exchange-rates failed:', err);
    return error.internal(c, 'Failed to fetch exchange rates');
  }
});

// ---------------------------------------------------------------------------
// GET /exchange-rate/:from/:to — rate between two currencies
// ---------------------------------------------------------------------------
app.get('/exchange-rate/:from/:to', requirePermission('accounts:read'), async (c) => {
  try {
    const from = c.req.param('from').toUpperCase();
    const to = c.req.param('to').toUpperCase();

    const rate = await getExchangeRate(from, to);
    return success(c, { from, to, rate, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[app-api/accounting-settings] exchange-rate/:from/:to failed:', err);
    return error.internal(c, 'Failed to fetch exchange rate');
  }
});

// ---------------------------------------------------------------------------
// POST /inbox — register accounting email inbox in master DB
// ---------------------------------------------------------------------------
app.post(
  '/inbox',
  requirePermission('accounts:update'),
  zValidator('json', registerInboxSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const { email } = c.req.valid('json');
    const workspaceId = c.get('workspaceId') as string;

    try {
      const masterDb = getMasterDb(c.env);
      const { mailAccountRegistry } = masterSchema;
      const accountId = `acct_inbox_${workspaceId}`;

      await masterDb
        .insert(mailAccountRegistry)
        .values({
          id: generateId('mar'),
          email: email.toLowerCase(),
          workspaceId,
          accountId,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: mailAccountRegistry.email,
          set: {
            workspaceId,
            accountId,
            isActive: true,
            updatedAt: new Date(),
          },
        });

      // Update accounting settings email config.
      const [currentSettings] = await db
        .select()
        .from(t)
        .where(isNull(t.deletedAt))
        .limit(1);

      if (currentSettings) {
        const emailSettings = (currentSettings.emailSettings as Record<string, unknown>) ?? {};
        await db
          .update(t)
          .set({
            emailSettings: {
              ...emailSettings,
              inboxAddress: email.toLowerCase(),
              autoScanEnabled: true,
            },
            updatedAt: new Date(),
          })
          .where(eq(t.id, currentSettings.id));

        await writeAccountingAudit(c, db, {
          accountingEntityId: currentSettings.defaultEntityId ?? null,
          entityType: 'accounting_settings',
          entityId: currentSettings.id,
          action: 'updated',
          changes: {
            emailSettings: {
              old: emailSettings,
              new: {
                ...emailSettings,
                inboxAddress: email.toLowerCase(),
                autoScanEnabled: true,
              },
            },
          },
        });
      }

      return success(c, { email: email.toLowerCase(), accountId });
    } catch (err) {
      console.error('[app-api/accounting-settings] register inbox failed:', err);
      return error.internal(c, 'Failed to register accounting inbox');
    }
  },
);

// ---------------------------------------------------------------------------
// POST /seed-workflows — seed finance workflow templates (idempotent).
// Template catalog ported verbatim from the legacy api-worker (Dutch strings
// included); only the auto-reconcile endpoint was updated to the app-api
// surface (/api/bank-transactions/auto-reconcile).
// ---------------------------------------------------------------------------
app.post('/seed-workflows', requirePermission('accounts:create'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { workflowTemplates } = schema;

    const existing = await db
      .select({ id: workflowTemplates.id })
      .from(workflowTemplates)
      .where(eq(workflowTemplates.category, 'finance'))
      .limit(1);

    if (existing.length > 0) {
      return error.conflict(c, 'Accounting workflow templates already seeded.');
    }

    const now = new Date();
    const templates = [
      {
        id: generateId('wft'),
        name: 'Betalingsherinnering',
        description: 'Stuur automatisch een herinnering wanneer een factuur over de vervaldatum is.',
        shortDescription: 'Herinnering bij verlopen facturen',
        category: 'finance',
        difficulty: 'beginner',
        estimatedSetupTime: 5,
        tags: ['accounting', 'invoices', 'reminders', 'email'],
        icon: 'bell',
        color: '#f59e0b',
        isOfficial: true,
        isPublic: true,
        isVerified: true,
        publishedAt: now,
        triggers: [
          {
            id: 'trg_overdue',
            type: 'entity_event' as const,
            name: 'Invoice overdue',
            isEnabled: true,
            config: {
              type: 'entity_event',
              entityType: 'invoice',
              eventType: 'updated',
              filters: [{ field: 'status', operator: 'equals', value: 'overdue' }],
            },
          },
        ],
        steps: [
          {
            id: 'step_wait',
            type: 'delay',
            name: 'Wait 1 day',
            config: { duration: 86400000 },
            inputs: {},
          },
          {
            id: 'step_email',
            type: 'send_email',
            name: 'Send reminder email',
            config: {
              template: 'payment_reminder',
              to: '{{trigger.data.contactEmail}}',
              subject: 'Herinnering: Factuur {{trigger.data.invoiceNumber}} is verlopen',
            },
            inputs: {},
          },
        ],
        settings: { timezone: 'Europe/Amsterdam', notifyOnError: true },
        authorName: 'WeldSuite',
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: generateId('wft'),
        name: 'Escalerende herinneringen',
        description: 'Stuur oplopende herinneringen na 7, 14 en 30 dagen na vervaldatum.',
        shortDescription: 'Getrapte herinneringen voor openstaande facturen',
        category: 'finance',
        difficulty: 'intermediate',
        estimatedSetupTime: 10,
        tags: ['accounting', 'invoices', 'reminders', 'escalation'],
        icon: 'alert-triangle',
        color: '#ef4444',
        isOfficial: true,
        isPublic: true,
        isVerified: true,
        publishedAt: now,
        triggers: [
          {
            id: 'trg_overdue_esc',
            type: 'entity_event' as const,
            name: 'Invoice overdue',
            isEnabled: true,
            config: {
              type: 'entity_event',
              entityType: 'invoice',
              eventType: 'updated',
              filters: [{ field: 'status', operator: 'equals', value: 'overdue' }],
            },
          },
        ],
        steps: [
          {
            id: 'step_r1',
            type: 'send_email',
            name: 'First reminder (7 days)',
            config: {
              template: 'payment_reminder_gentle',
              to: '{{trigger.data.contactEmail}}',
              subject: 'Herinnering: Factuur {{trigger.data.invoiceNumber}}',
              delay: 604800000,
            },
            inputs: {},
          },
          {
            id: 'step_r2',
            type: 'send_email',
            name: 'Second reminder (14 days)',
            config: {
              template: 'payment_reminder_firm',
              to: '{{trigger.data.contactEmail}}',
              subject: 'Tweede herinnering: Factuur {{trigger.data.invoiceNumber}}',
              delay: 604800000,
            },
            inputs: {},
          },
          {
            id: 'step_r3',
            type: 'send_email',
            name: 'Final notice (30 days)',
            config: {
              template: 'payment_reminder_final',
              to: '{{trigger.data.contactEmail}}',
              subject: 'Aanmaning: Factuur {{trigger.data.invoiceNumber}}',
              delay: 1382400000,
            },
            inputs: {},
          },
        ],
        settings: { timezone: 'Europe/Amsterdam', notifyOnError: true },
        authorName: 'WeldSuite',
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: generateId('wft'),
        name: 'Factuur goedkeuring',
        description: 'Stuur inkoopfacturen ter goedkeuring voordat ze betaald worden.',
        shortDescription: 'Goedkeuringsworkflow voor inkoopfacturen',
        category: 'finance',
        difficulty: 'intermediate',
        estimatedSetupTime: 10,
        tags: ['accounting', 'bills', 'approval', 'workflow'],
        icon: 'check-circle',
        color: '#10b981',
        isOfficial: true,
        isPublic: true,
        isVerified: true,
        publishedAt: now,
        triggers: [
          {
            id: 'trg_bill_created',
            type: 'entity_event' as const,
            name: 'Bill created',
            isEnabled: true,
            config: { type: 'entity_event', entityType: 'bill', eventType: 'created' },
          },
        ],
        steps: [
          {
            id: 'step_notify',
            type: 'send_notification',
            name: 'Notify approver',
            config: {
              message:
                'Nieuwe inkoopfactuur: {{trigger.data.externalReference}} van {{trigger.data.contactName}}',
              channel: 'in_app',
            },
            inputs: {},
          },
          {
            id: 'step_wait',
            type: 'wait_for_action',
            name: 'Wait for approval',
            config: { timeout: 604800000, actions: ['approve', 'reject'] },
            inputs: {},
          },
        ],
        settings: { timezone: 'Europe/Amsterdam', notifyOnError: true },
        authorName: 'WeldSuite',
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: generateId('wft'),
        name: 'Auto-categoriseer banktransacties',
        description:
          'Pas automatisch afstemmingsregels toe op geïmporteerde banktransacties.',
        shortDescription: 'Automatisch categoriseren van banktransacties',
        category: 'finance',
        difficulty: 'beginner',
        estimatedSetupTime: 5,
        tags: ['accounting', 'banking', 'reconciliation', 'automation'],
        icon: 'git-merge',
        color: '#6366f1',
        isOfficial: true,
        isPublic: true,
        isVerified: true,
        publishedAt: now,
        triggers: [
          {
            id: 'trg_bank_import',
            type: 'entity_event' as const,
            name: 'Bank transaction imported',
            isEnabled: true,
            config: {
              type: 'entity_event',
              entityType: 'bank_transaction',
              eventType: 'created',
            },
          },
        ],
        steps: [
          {
            id: 'step_rules',
            type: 'custom_action',
            name: 'Apply reconciliation rules',
            config: {
              action: 'apply_reconciliation_rules',
              endpoint: '/api/bank-transactions/auto-reconcile',
            },
            inputs: {},
          },
        ],
        settings: { timezone: 'Europe/Amsterdam' },
        authorName: 'WeldSuite',
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: generateId('wft'),
        name: 'BTW deadline herinnering',
        description:
          'Herinnering 30 dagen voor het einde van het kwartaal om de BTW-aangifte voor te bereiden.',
        shortDescription: 'Herinnering voor BTW-aangifte deadlines',
        category: 'finance',
        difficulty: 'beginner',
        estimatedSetupTime: 3,
        tags: ['accounting', 'vat', 'btw', 'reminders', 'tax'],
        icon: 'calendar',
        color: '#8b5cf6',
        isOfficial: true,
        isPublic: true,
        isVerified: true,
        publishedAt: now,
        triggers: [
          {
            id: 'trg_btw_cron',
            type: 'schedule' as const,
            name: 'Monthly check',
            isEnabled: true,
            config: {
              type: 'schedule',
              cronExpression: '0 9 1 */1 *',
              timezone: 'Europe/Amsterdam',
            },
          },
        ],
        steps: [
          {
            id: 'step_check',
            type: 'condition',
            name: 'Check if BTW deadline approaching',
            config: { field: 'currentMonth', operator: 'in', value: [3, 6, 9, 12] },
            inputs: {},
          },
          {
            id: 'step_notify',
            type: 'send_notification',
            name: 'Send BTW deadline reminder',
            config: {
              message: 'BTW-aangifte deadline nadert. Bereid uw aangifte voor!',
              channel: 'in_app',
            },
            inputs: {},
          },
        ],
        settings: { timezone: 'Europe/Amsterdam' },
        authorName: 'WeldSuite',
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: generateId('wft'),
        name: 'Nieuw document melding',
        description: 'Stuur een melding wanneer een nieuw document is ontvangen via e-mail of upload.',
        shortDescription: 'Melding bij nieuw ontvangen document',
        category: 'finance',
        difficulty: 'beginner',
        estimatedSetupTime: 3,
        tags: ['accounting', 'documents', 'notifications', 'inbox'],
        icon: 'file-text',
        color: '#0ea5e9',
        isOfficial: true,
        isPublic: true,
        isVerified: true,
        publishedAt: now,
        triggers: [
          {
            id: 'trg_doc',
            type: 'entity_event' as const,
            name: 'Document received',
            isEnabled: true,
            config: {
              type: 'entity_event',
              entityType: 'accounting_document',
              eventType: 'created',
            },
          },
        ],
        steps: [
          {
            id: 'step_notify',
            type: 'send_notification',
            name: 'Notify about new document',
            config: {
              message:
                'Nieuw document ontvangen: {{trigger.data.originalFileName}} ({{trigger.data.source}})',
              channel: 'in_app',
            },
            inputs: {},
          },
        ],
        settings: { timezone: 'Europe/Amsterdam' },
        authorName: 'WeldSuite',
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: generateId('wft'),
        name: 'Betaling ontvangen bevestiging',
        description: 'Stuur een bevestiging wanneer een betaling op een factuur is ontvangen.',
        shortDescription: 'Bevestiging van ontvangen betalingen',
        category: 'finance',
        difficulty: 'beginner',
        estimatedSetupTime: 5,
        tags: ['accounting', 'payments', 'notifications', 'email'],
        icon: 'credit-card',
        color: '#22c55e',
        isOfficial: true,
        isPublic: true,
        isVerified: true,
        publishedAt: now,
        triggers: [
          {
            id: 'trg_pay',
            type: 'entity_event' as const,
            name: 'Payment received',
            isEnabled: true,
            config: {
              type: 'entity_event',
              entityType: 'payment',
              eventType: 'created',
              filters: [{ field: 'type', operator: 'equals', value: 'received' }],
            },
          },
        ],
        steps: [
          {
            id: 'step_email',
            type: 'send_email',
            name: 'Send payment confirmation',
            config: {
              template: 'payment_received',
              to: '{{trigger.data.contactEmail}}',
              subject: 'Betaling ontvangen — Bedankt!',
            },
            inputs: {},
          },
        ],
        settings: { timezone: 'Europe/Amsterdam' },
        authorName: 'WeldSuite',
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
    ];

    await db.insert(workflowTemplates).values(templates as unknown as (typeof workflowTemplates.$inferInsert)[]);

    return success(c, { templatesCreated: templates.length }, 201);
  } catch (err) {
    console.error('[app-api/accounting-settings] seed-workflows failed:', err);
    return error.internal(c, 'Failed to seed accounting workflow templates');
  }
});

export const accountingSettingsRoutes = app;
