/**
 * What the helpdesk-widget-api integration tests share: the master rows that
 * resolve a widget id to a workspace (`widget_registry`, `workspaces`, `plans`),
 * the tenant row that configures it (`desk_widget_settings`), and the env
 * bindings every test passes.
 *
 * One tenant database serves every workspace in a test file (the file mocks
 * the worker's tenant lookup to hand out that one database), so the workspaces
 * differ only in what the master database says about them: their Clerk org id
 * (events and attachment keys carry it) and their plan (branding).
 *
 * Conformance-ready: every id and timestamp is fixed.
 */

import * as masterSchema from '@weldsuite/db/schema/master';
import * as tenantSchema from '@weldsuite/db/schema';
import type { Database } from '@weldsuite/worker-kit/db';
import { pgliteClientOf } from '@weldsuite/worker-kit/testing/pglite';

/** The workspace most tests use: no plan, so the widget shows the WeldSuite branding. */
export const ORG = 'org_acme';
export const WORKSPACE = 'ws_acme';
/** A widget of that workspace with default settings, enabled, no domain allowlist. */
export const WIDGET = 'wdg_main';

/** The public bucket origin (`R2_PUBLIC_URL`), with a trailing slash the worker strips. */
export const FILES_ORIGIN = 'https://files.widget.test';
export const REALTIME_URL = 'wss://realtime.widget.test';
export const TOKEN_SECRET = 'widget-token-secret-for-tests';

/** 2026-01-01 12:`minute`:`second` UTC. */
export const at = (second: number, minute = 0) => new Date(Date.UTC(2026, 0, 1, 12, minute, second));

export const widgetHeaders = (widgetId: string = WIDGET, extra: Record<string, string> = {}) => ({
  'x-widget-id': widgetId,
  ...extra,
});

/** A JSON request as the widget sends it. */
export const json = (
  body: unknown,
  { method = 'POST', widgetId = WIDGET, headers = {} }: { method?: string; widgetId?: string | null; headers?: Record<string, string> } = {},
): RequestInit => ({
  method,
  headers: {
    'Content-Type': 'application/json',
    ...(widgetId === null ? {} : { 'x-widget-id': widgetId }),
    ...headers,
  },
  body: JSON.stringify(body),
});

/** A GET carrying the widget id (and whatever else, e.g. an `Origin`). */
export const get = (widgetId: string | null = WIDGET, headers: Record<string, string> = {}): RequestInit => ({
  headers: { ...(widgetId === null ? {} : { 'x-widget-id': widgetId }), ...headers },
});

/** The bindings a deployed worker has that the routes read; no `WORKSPACE_CACHE`, so the rate limiter no-ops. */
export function widgetEnv(overrides: Record<string, unknown> = {}): never {
  return {
    ENVIRONMENT: 'test',
    REALTIME_INTERNAL_SECRET: 'realtime-internal-secret',
    WIDGET_TOKEN_SECRET: TOKEN_SECRET,
    R2_PUBLIC_URL: `${FILES_ORIGIN}/`,
    REALTIME_PUBLIC_URL: REALTIME_URL,
    PUBLIC_APP_URL: 'https://app.widget.test',
    ...overrides,
  } as never;
}

/** Plans (one that removes the branding, one that does not) and the workspaces that use them. */
export async function seedWorkspaces(master: Database): Promise<void> {
  await master.insert(masterSchema.plans).values([
    { id: 'plan_basic', name: 'Basic', slug: 'basic', removeBranding: false },
    { id: 'plan_white', name: 'White label', slug: 'white-label', removeBranding: true },
  ]);
  await master.insert(masterSchema.workspaces).values([
    { id: WORKSPACE, clerkOrgId: ORG, name: 'Acme', slug: 'acme' },
    { id: 'ws_basic', clerkOrgId: 'org_basic', name: 'Basic Co', slug: 'basic-co', planId: 'plan_basic' },
    { id: 'ws_white', clerkOrgId: 'org_white', name: 'White Co', slug: 'white-co', planId: 'plan_white' },
    { id: 'ws_noorg', clerkOrgId: null, name: 'No Org', slug: 'no-org' },
  ]);
}

export interface WidgetSetup {
  /** The registry row's workspace (`workspaces.id`); default the main one. */
  workspaceId?: string;
  /** `widget_registry.is_active`; default true. */
  active?: boolean;
  /** The tenant's `desk_widget_settings` row; null for none. Default: an enabled widget with nothing set. */
  settings?: Partial<typeof tenantSchema.deskWidgetSettings.$inferInsert> | null;
}

/** Register a widget in the master database and configure it in the tenant database. */
export async function addWidget(master: Database, tenant: Database, widgetId: string, setup: WidgetSetup = {}): Promise<void> {
  await master.insert(masterSchema.widgetRegistry).values({
    id: `wreg_${widgetId}`,
    widgetId,
    workspaceId: setup.workspaceId ?? WORKSPACE,
    isActive: setup.active ?? true,
    createdAt: at(0),
    updatedAt: at(0),
  });
  if (setup.settings === null) return;
  await tenant.insert(tenantSchema.deskWidgetSettings).values({
    id: `dws_${widgetId}`,
    widgetId,
    enabled: true,
    createdAt: at(0),
    updatedAt: at(0),
    ...setup.settings,
  });
}

/**
 * A registry row whose workspace row is gone. The foreign key cascades a
 * workspace's deletion to its widgets, so this only exists in the instant a
 * request lands between the two; the check is skipped for the insert.
 */
export async function addDanglingWidget(master: Database, widgetId: string): Promise<void> {
  const client = pgliteClientOf(master);
  if (!client) throw new Error('addDanglingWidget needs the pglite master database');
  await client.exec('SET session_replication_role = replica');
  try {
    await master.insert(masterSchema.widgetRegistry).values({
      id: `wreg_${widgetId}`,
      widgetId,
      workspaceId: 'ws_gone',
      isActive: true,
      createdAt: at(0),
      updatedAt: at(0),
    });
  } finally {
    await client.exec('SET session_replication_role = DEFAULT');
  }
}

/** A workspace member row (`workspace_members`), active and internal unless said otherwise. */
export function member(
  userId: string,
  values: Partial<typeof tenantSchema.workspaceMembers.$inferInsert> = {},
): typeof tenantSchema.workspaceMembers.$inferInsert {
  return {
    id: `wm_${userId}`,
    userId,
    email: `${userId}@acme.test`,
    name: userId,
    role: 'MEMBER',
    status: 'ACTIVE',
    memberType: 'INTERNAL',
    createdAt: at(0),
    updatedAt: at(0),
    ...values,
  };
}
