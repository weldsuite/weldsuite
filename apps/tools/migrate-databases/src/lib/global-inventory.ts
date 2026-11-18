/**
 * Read-only inventory of the Global deployment, for phase 0 of Global's
 * retirement (ADR OPS-025, `weldsuite-documentation/plans/retire-global-edition.md`):
 * what has to move, and the facts behind the plan's open questions.
 *
 * Everything here reads; nothing writes. The report holds workspace ids,
 * counts, provider names and plan slugs, never names, email addresses or
 * domain names, so it can be shared while the move is planned.
 *
 * The SQL runs through `Query`, which postgres-js (the CLI, against Neon) and
 * PGlite (the test, against the migrated schema) both satisfy.
 */

/** One read query: rows as plain objects. */
export type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** postgres-js returns counts and sums as strings; PGlite as numbers. */
function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** An error message with any connection string removed. */
export function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-connection-string>');
}

/** Runs one probe; a failure is recorded under its label and the rest go on. */
async function probe<T>(errors: string[], label: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    errors.push(`${label}: ${sanitizeError(err)}`);
    return fallback;
  }
}

function countMap(rows: Record<string, unknown>[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[str(row[key]) ?? '(none)'] = num(row.n);
  return out;
}

// ---------------------------------------------------------------------------
// Master database
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string;
  planSlug: string | null;
  isActive: boolean;
  deleted: boolean;
  deletionScheduled: boolean;
  provisioningStatus: string | null;
  createdAt: string | null;
  subscriptionStatus: string | null;
  subscriptionCycle: string | null;
  billingMode: string | null;
  partnerManaged: boolean;
  hasStripeSubscription: boolean;
  purchasedSeats: number;
  /** `shared` (a Neon shard), `dedicated` (its own Neon project) or `none` (no database). */
  placement: 'shared' | 'dedicated' | 'none';
  region: string | null;
  membersActive: number;
  membersPending: number;
}

export interface PlanRow {
  id: string;
  slug: string | null;
  currency: string | null;
  priceMonthly: number;
  priceYearly: number;
  pricePerUser: number;
}

export interface MasterInventory {
  users: { total: number; active: number };
  workspaces: WorkspaceRow[];
  plans: PlanRow[];
  sso: Array<{ workspaceId: string; provider: string | null; enabled: boolean; clerkActive: boolean | null }>;
  credits: { workspacesWithBalance: number; totalBalance: number };
  weldApps: { paidInstalls: number; activeTokens: number; tokensUsed30d: number; oauthClients: number };
  helpcenterDomains: Record<string, number>;
  databaseMoves: Record<string, number>;
  partners: number;
  errors: string[];
}

export async function masterInventory(query: Query): Promise<MasterInventory> {
  const errors: string[] = [];

  const users = await probe(errors, 'users', { total: 0, active: 0 }, async () => {
    const [row] = await query('select count(*) as total, count(*) filter (where is_active) as active from users');
    return { total: num(row?.total), active: num(row?.active) };
  });

  const members = await probe(errors, 'user_workspaces', new Map<string, { active: number; pending: number }>(), async () => {
    const rows = await query(
      `select workspace_id,
              count(*) filter (where status = 'ACTIVE') as active,
              count(*) filter (where status = 'PENDING') as pending
         from user_workspaces group by workspace_id`,
    );
    return new Map(rows.map((r) => [String(r.workspace_id), { active: num(r.active), pending: num(r.pending) }]));
  });

  const workspaces = await probe(errors, 'workspaces', [] as WorkspaceRow[], async () => {
    const rows = await query(
      `select w.id, p.slug as plan_slug, w.is_active, w.deleted_at is not null as deleted,
              w.scheduled_deletion_at is not null as deletion_scheduled, w.provisioning_status, w.created_at,
              w.subscription_status, w.subscription_cycle, w.billing_mode, w.partner_id is not null as partner_managed,
              w.stripe_subscription_id is not null as has_stripe_subscription, w.purchased_seats,
              w.neon_project_id, w.shared_project_id, w.database_url is not null as has_database_url,
              coalesce(w.neon_region, sp.region) as region
         from workspaces w
         left join plans p on p.id = w.plan_id
         left join neon_shared_projects sp on sp.id = w.shared_project_id
        order by w.created_at`,
    );
    return rows.map((r): WorkspaceRow => {
      const id = String(r.id);
      const m = members.get(id);
      const hasDatabase = Boolean(r.neon_project_id) || Boolean(r.has_database_url);
      let placement: WorkspaceRow['placement'] = 'none';
      if (hasDatabase) placement = r.shared_project_id ? 'shared' : 'dedicated';
      return {
        id,
        planSlug: str(r.plan_slug),
        isActive: Boolean(r.is_active),
        deleted: Boolean(r.deleted),
        deletionScheduled: Boolean(r.deletion_scheduled),
        provisioningStatus: str(r.provisioning_status),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : str(r.created_at),
        subscriptionStatus: str(r.subscription_status),
        subscriptionCycle: str(r.subscription_cycle),
        billingMode: str(r.billing_mode),
        partnerManaged: Boolean(r.partner_managed),
        hasStripeSubscription: Boolean(r.has_stripe_subscription),
        purchasedSeats: num(r.purchased_seats),
        placement,
        region: str(r.region),
        membersActive: m?.active ?? 0,
        membersPending: m?.pending ?? 0,
      };
    });
  });

  const plans = await probe(errors, 'plans', [] as PlanRow[], async () => {
    const rows = await query('select id, slug, currency, price_monthly, price_yearly, price_per_user from plans order by slug');
    return rows.map((r) => ({
      id: String(r.id),
      slug: str(r.slug),
      currency: str(r.currency),
      priceMonthly: num(r.price_monthly),
      priceYearly: num(r.price_yearly),
      pricePerUser: num(r.price_per_user),
    }));
  });

  const sso = await probe(errors, 'workspace_sso', [] as MasterInventory['sso'], async () => {
    const rows = await query('select workspace_id, provider, enabled, clerk_active from workspace_sso');
    return rows.map((r) => ({
      workspaceId: String(r.workspace_id),
      provider: str(r.provider),
      enabled: Boolean(r.enabled),
      clerkActive: r.clerk_active === null || r.clerk_active === undefined ? null : Boolean(r.clerk_active),
    }));
  });

  const credits = await probe(errors, 'workspace_credits', { workspacesWithBalance: 0, totalBalance: 0 }, async () => {
    const [row] = await query(
      'select count(*) filter (where current_balance <> 0) as n, coalesce(sum(current_balance), 0) as total from workspace_credits',
    );
    return { workspacesWithBalance: num(row?.n), totalBalance: num(row?.total) };
  });

  const weldApps = await probe(
    errors,
    'user apps',
    { paidInstalls: 0, activeTokens: 0, tokensUsed30d: 0, oauthClients: 0 },
    async () => {
      const [row] = await query(
        `select (select count(*) from user_app_installs where stripe_subscription_id is not null and revoked_at is null) as paid_installs,
                (select count(*) from user_app_tokens where revoked_at is null) as active_tokens,
                (select count(*) from user_app_tokens where revoked_at is null and last_used_at > now() - interval '30 days') as used_30d,
                (select count(*) from user_app_oauth_clients) as oauth_clients`,
      );
      return {
        paidInstalls: num(row?.paid_installs),
        activeTokens: num(row?.active_tokens),
        tokensUsed30d: num(row?.used_30d),
        oauthClients: num(row?.oauth_clients),
      };
    },
  );

  const helpcenterDomains = await probe(errors, 'helpcenter_domain_registry', {} as Record<string, number>, async () =>
    countMap(
      await query('select domain_type, count(*) as n from helpcenter_domain_registry where coalesce(is_active::int, 0) <> 0 group by domain_type'),
      'domain_type',
    ),
  );

  const databaseMoves = await probe(errors, 'workspace_database_moves', {} as Record<string, number>, async () =>
    countMap(await query('select status, count(*) as n from workspace_database_moves group by status'), 'status'),
  );

  const partners = await probe(errors, 'partners', 0, async () => {
    const [row] = await query('select count(*) as n from partners');
    return num(row?.n);
  });

  return { users, workspaces, plans, sso, credits, weldApps, helpcenterDomains, databaseMoves, partners, errors };
}

// ---------------------------------------------------------------------------
// Tenant databases
// ---------------------------------------------------------------------------

export interface IntegrationRow {
  /** The table the connection lives in. */
  source: string;
  provider: string;
  status: string;
  count: number;
}

export interface TenantInventory {
  databaseBytes: number;
  members: Record<string, number>;
  mail: {
    customDomains: number;
    accounts: number;
    weldmailAddresses: number;
    messagesEstimate: number;
    scheduledSends: number;
    snoozed: number;
  };
  helpcenter: { customDomains: number; customDomainsVerified: number };
  phoneNumbers: Record<string, number>;
  apiKeys: { workspaceKeys: number; workspaceKeysUsed30d: number; personalKeys: number; personalKeysUsed30d: number };
  integrations: IntegrationRow[];
  /** Work a Cloudflare Workflow or alarm may be holding, by `<table>.<state>`. */
  pending: Record<string, number>;
  portals: { commercePortalEnabled: boolean; commercePortalAccounts: number; projectPortalStakeholders: number };
  storageBytes: { files: number; projectFiles: number; mailAttachments: number; mailboxes: number };
  errors: string[];
}

/** Connection tables: `<table>`, the provider expression, the status expression, and the live filter. */
const INTEGRATION_SOURCES: ReadonlyArray<{ table: string; provider: string; status: string; where: string }> = [
  { table: 'integration_connections', provider: 'provider', status: 'status', where: 'deleted_at is null' },
  { table: 'connector_connections', provider: 'provider', status: 'status', where: 'deleted_at is null' },
  { table: 'product_connections', provider: 'platform', status: 'sync_status', where: 'true' },
  { table: 'workflow_integrations', provider: 'coalesce(oauth_provider, type)', status: 'status', where: 'deleted_at is null' },
  { table: 'bank_connections', provider: 'provider', status: 'status', where: 'deleted_at is null' },
  { table: 'ad_platform_connections', provider: 'platform', status: 'status', where: 'true' },
  { table: 'github_connections', provider: "'github'", status: 'status', where: 'true' },
  { table: 'merge_connections', provider: 'provider', status: 'status', where: 'true' },
  { table: 'helpdesk_channel_integrations', provider: 'provider', status: 'status', where: 'true' },
  { table: 'social_accounts', provider: 'platform', status: 'status', where: 'true' },
];

export async function tenantInventory(query: Query): Promise<TenantInventory> {
  const errors: string[] = [];
  const count = async (label: string, text: string): Promise<number> =>
    probe(errors, label, 0, async () => num((await query(text))[0]?.n));

  const databaseBytes = await count('database size', 'select pg_database_size(current_database()) as n');

  const members = await probe(errors, 'workspace_members', {} as Record<string, number>, async () =>
    countMap(await query('select status, count(*) as n from workspace_members group by status'), 'status'),
  );

  const mail = {
    customDomains: await count('mail_domains', 'select count(*) as n from mail_domains where is_active and deleted_at is null'),
    accounts: await count('mail_accounts', 'select count(*) as n from mail_accounts'),
    weldmailAddresses: await count(
      'mail_accounts weldmail',
      "select count(*) as n from mail_accounts where lower(email) like '%.weldmail.com' or lower(email) like '%.weldmail.org'",
    ),
    messagesEstimate: await count(
      'mail_messages estimate',
      "select greatest(reltuples, 0)::bigint as n from pg_class where relname = 'mail_messages'",
    ),
    scheduledSends: await count('mail_messages scheduled', "select count(*) as n from mail_messages where send_status = 'scheduled'"),
    snoozed: await count('mail_messages snoozed', 'select count(*) as n from mail_messages where snoozed_until > now()'),
  };

  const helpcenter = await probe(errors, 'helpcenter_domains', { customDomains: 0, customDomainsVerified: 0 }, async () => {
    const [row] = await query(
      `select count(*) filter (where domain_type = 'custom') as custom,
              count(*) filter (where domain_type = 'custom' and coalesce(is_verified::int, 0) <> 0) as verified
         from helpcenter_domains`,
    );
    return { customDomains: num(row?.custom), customDomainsVerified: num(row?.verified) };
  });

  const phoneNumbers = await probe(errors, 'voip_phone_numbers', {} as Record<string, number>, async () =>
    countMap(
      await query('select provider, count(*) as n from voip_phone_numbers where deleted_at is null group by provider'),
      'provider',
    ),
  );

  const apiKeys = await probe(
    errors,
    'api keys',
    { workspaceKeys: 0, workspaceKeysUsed30d: 0, personalKeys: 0, personalKeysUsed30d: 0 },
    async () => {
      const [row] = await query(
        `select (select count(*) from workspace_api_keys where deleted_at is null) as workspace_keys,
                (select count(*) from workspace_api_keys where deleted_at is null and last_used_at > now() - interval '30 days') as workspace_used,
                (select count(*) from api_keys where deleted_at is null) as personal_keys,
                (select count(*) from api_keys where deleted_at is null and last_used_at > now() - interval '30 days') as personal_used`,
      );
      return {
        workspaceKeys: num(row?.workspace_keys),
        workspaceKeysUsed30d: num(row?.workspace_used),
        personalKeys: num(row?.personal_keys),
        personalKeysUsed30d: num(row?.personal_used),
      };
    },
  );

  // One connection queues these anyway; Promise.all just keeps the loop free of awaits.
  const perSource = await Promise.all(
    INTEGRATION_SOURCES.map(async (source) => ({
      source,
      rows: await probe(errors, source.table, [] as Record<string, unknown>[], () =>
        query(
          `select ${source.provider} as provider, ${source.status} as status, count(*) as n
             from ${source.table} where ${source.where} group by 1, 2`,
        ),
      ),
    })),
  );
  const integrations: IntegrationRow[] = [];
  for (const { source, rows } of perSource) {
    for (const r of rows) {
      integrations.push({
        source: source.table,
        provider: str(r.provider) ?? '(none)',
        status: str(r.status) ?? '(none)',
        count: num(r.n),
      });
    }
  }

  const pending: Record<string, number> = {
    'mail_messages.scheduled': mail.scheduledSends,
    'mail_messages.snoozed': mail.snoozed,
    'sequence_enrollments.active': await count(
      'sequence_enrollments',
      "select count(*) as n from sequence_enrollments where status = 'active'",
    ),
    'workflow_schedules.enabled': await count('workflow_schedules', 'select count(*) as n from workflow_schedules where is_enabled'),
    'chat_reminders.future': await count('chat_reminders', 'select count(*) as n from chat_reminders where remind_at > now()'),
    'chat_messages.pin_expiry': await count('chat_messages', 'select count(*) as n from chat_messages where pin_expires_at > now()'),
    'social_posts.scheduled': await count('social_posts', "select count(*) as n from social_posts where status = 'scheduled'"),
  };
  const executions = await probe(errors, 'workflow_executions', {} as Record<string, number>, async () =>
    countMap(await query('select status, count(*) as n from workflow_executions group by status'), 'status'),
  );
  for (const [status, n] of Object.entries(executions)) pending[`workflow_executions.${status}`] = n;
  const reach = await probe(errors, 'reach_enrollments', {} as Record<string, number>, async () =>
    countMap(await query('select status, count(*) as n from reach_enrollments group by status'), 'status'),
  );
  for (const [status, n] of Object.entries(reach)) pending[`reach_enrollments.${status}`] = n;

  const portals = {
    commercePortalEnabled:
      (await count('commerce_portal_settings', 'select count(*) as n from commerce_portal_settings where coalesce(is_enabled::int, 0) <> 0')) > 0,
    commercePortalAccounts: await count('commerce_portal_access', 'select count(*) as n from commerce_portal_access'),
    projectPortalStakeholders: await count(
      'project_stakeholders',
      'select count(*) as n from project_stakeholders where portal_access',
    ),
  };

  const storageBytes = {
    files: await count('files size', 'select coalesce(sum(file_size), 0) as n from files'),
    projectFiles: await count('project_files size', 'select coalesce(sum(file_size), 0) as n from project_files'),
    mailAttachments: await count('mail_attachments size', 'select coalesce(sum(size), 0) as n from mail_attachments'),
    mailboxes: await count('mail_accounts storage', 'select coalesce(sum(storage_used), 0) as n from mail_accounts'),
  };

  return { databaseBytes, members, mail, helpcenter, phoneNumbers, apiKeys, integrations, pending, portals, storageBytes, errors };
}

// ---------------------------------------------------------------------------
// Clerk
// ---------------------------------------------------------------------------

export interface ClerkInventory {
  users: number;
  withPassword: number;
  withTotp: number;
  withBackupCodes: number;
  withTwoFactor: number;
  withPasskeys: number;
  withEnterpriseAccount: number;
  banned: number;
  /** Social sign-in links by Clerk provider (`oauth_google`, …): what WeldID has to link by provider subject. */
  externalProviders: Record<string, number>;
  samlConnections: { total: number; active: number } | null;
  /** OAuth applications: on Global these are the MCP clients that registered themselves. */
  oauthApplications: number | null;
  errors: string[];
}

type ClerkUser = {
  password_enabled?: boolean;
  totp_enabled?: boolean;
  backup_code_enabled?: boolean;
  two_factor_enabled?: boolean;
  banned?: boolean;
  passkeys?: unknown[];
  external_accounts?: Array<{ provider?: string }>;
  saml_accounts?: unknown[];
  enterprise_accounts?: unknown[];
};

type ClerkCount = 'withPassword' | 'withTotp' | 'withBackupCodes' | 'withTwoFactor' | 'banned' | 'withPasskeys' | 'withEnterpriseAccount';

/** Adds one Clerk user to the counts; a user with two Google links counts once for Google. */
function tallyClerkUser(out: ClerkInventory, user: ClerkUser): void {
  const flags: Array<[boolean, ClerkCount]> = [
    [Boolean(user.password_enabled), 'withPassword'],
    [Boolean(user.totp_enabled), 'withTotp'],
    [Boolean(user.backup_code_enabled), 'withBackupCodes'],
    [Boolean(user.two_factor_enabled), 'withTwoFactor'],
    [Boolean(user.banned), 'banned'],
    [(user.passkeys?.length ?? 0) > 0, 'withPasskeys'],
    [(user.saml_accounts?.length ?? 0) + (user.enterprise_accounts?.length ?? 0) > 0, 'withEnterpriseAccount'],
  ];
  out.users += 1;
  for (const [on, key] of flags) if (on) out[key] += 1;
  for (const provider of new Set((user.external_accounts ?? []).map((a) => a.provider ?? '(unknown)'))) {
    out.externalProviders[provider] = (out.externalProviders[provider] ?? 0) + 1;
  }
}

const CLERK_API = 'https://api.clerk.com/v1';
const CLERK_PAGE = 500;

/** Aggregates over every Clerk user. Holds counts only: no ids, names or addresses. */
export async function clerkInventory(secretKey: string, fetchFn: typeof fetch = fetch): Promise<ClerkInventory> {
  const errors: string[] = [];
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchFn(`${CLERK_API}${path}`, { headers: { Authorization: `Bearer ${secretKey}` } });
    if (!res.ok) throw new Error(`Clerk ${path.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  };

  const out: ClerkInventory = {
    users: 0,
    withPassword: 0,
    withTotp: 0,
    withBackupCodes: 0,
    withTwoFactor: 0,
    withPasskeys: 0,
    withEnterpriseAccount: 0,
    banned: 0,
    externalProviders: {},
    samlConnections: null,
    oauthApplications: null,
    errors,
  };

  await probe(errors, 'clerk users', undefined, async () => {
    for (let offset = 0; ; offset += CLERK_PAGE) {
      const page = (await get(`/users?limit=${CLERK_PAGE}&offset=${offset}&order_by=created_at`)) as ClerkUser[];
      for (const user of page) tallyClerkUser(out, user);
      if (page.length < CLERK_PAGE) break;
    }
  });

  out.samlConnections = await probe(errors, 'clerk saml_connections', null, async () => {
    const body = (await get('/saml_connections?limit=100')) as { data?: Array<{ active?: boolean }>; total_count?: number };
    const data = body.data ?? [];
    return { total: body.total_count ?? data.length, active: data.filter((c) => c.active).length };
  });

  out.oauthApplications = await probe(errors, 'clerk oauth_applications', null, async () => {
    const body = (await get('/oauth_applications?limit=100')) as { data?: unknown[]; total_count?: number };
    return body.total_count ?? body.data?.length ?? 0;
  });

  return out;
}

// ---------------------------------------------------------------------------
// WeldMail store modes (mail-api's staff endpoint)
// ---------------------------------------------------------------------------

export interface MailStoreAdmin {
  baseUrl: string;
  secret: string;
  adminEmail: string;
}

export function mailStoreAdminFromEnv(env: NodeJS.ProcessEnv): MailStoreAdmin | null {
  const baseUrl = env.MAIL_STORE_ADMIN_URL?.trim();
  const secret = env.OUTBOUND_ADMIN_SECRET?.trim();
  const adminEmail = env.MAIL_STORE_ADMIN_EMAIL?.trim();
  if (!baseUrl || !secret || !adminEmail) return null;
  let end = baseUrl.length;
  while (end > 0 && baseUrl.codePointAt(end - 1) === 47 /* '/' */) end -= 1;
  return { baseUrl: baseUrl.slice(0, end), secret, adminEmail };
}

/** Each mailbox's stored mode for one workspace, counted: `{ postgres: 2, 'object-only': 1 }`. */
export async function mailStoreModes(
  admin: MailStoreAdmin,
  workspaceId: string,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const res = await fetchFn(
    `${admin.baseUrl}/internal/mail-store/status/all?workspaceId=${encodeURIComponent(workspaceId)}`,
    { headers: { 'x-admin-secret': admin.secret, 'x-admin-email': admin.adminEmail } },
  );
  if (!res.ok) throw new Error(`mail-store status: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ status?: { mode?: string }; error?: string }> };
  const modes: Record<string, number> = {};
  for (const row of body.data ?? []) {
    const mode = row.status?.mode ?? (row.error ? '(error)' : '(unknown)');
    modes[mode] = (modes[mode] ?? 0) + 1;
  }
  return modes;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface WorkspaceReport {
  id: string;
  tenant: TenantInventory | null;
  /** Why the tenant database wasn't read (no database, connection failed, …). */
  tenantSkipped: string | null;
  mailStoreModes: Record<string, number> | null;
}

export interface GlobalInventory {
  generatedAt: string;
  master: MasterInventory;
  workspaces: WorkspaceReport[];
  clerk: ClerkInventory | null;
  mailStoreChecked: boolean;
}

const MB = 1024 * 1024;
const mb = (bytes: number): string => (bytes / MB).toFixed(1);
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** `a 1, b 2`, sorted by key, or a dash when empty. */
function entries(map: Record<string, number>): string {
  const parts = Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join(', ') : '—';
}

/** ` (ws_a, ws_b)` to follow a count, or nothing for an empty list. */
function idList(ids: string[]): string {
  return ids.length > 0 ? ' (' + ids.join(', ') + ')' : '';
}

function mergeCounts(maps: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const map of maps) for (const [k, v] of Object.entries(map)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function tally<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

function storage(t: TenantInventory | null): number {
  return t ? t.storageBytes.files + t.storageBytes.projectFiles + t.storageBytes.mailAttachments : 0;
}

function workspaceState(m: WorkspaceRow | undefined): string {
  if (!m) return '?';
  if (m.deleted) return 'deleted';
  if (m.deletionScheduled) return 'deleting';
  return m.isActive ? 'active' : 'inactive';
}

function totalsSection(inv: GlobalInventory, tenants: TenantInventory[], live: WorkspaceRow[]): string[] {
  const { master } = inv;
  const partnerManaged = master.workspaces.filter((w) => w.partnerManaged).length;
  return [
    '## Totals',
    '',
    `- Workspaces: ${master.workspaces.length} (${live.length} active and not deleted)`,
    `- Users: ${master.users.total} (${master.users.active} active)`,
    `- Tenant databases read: ${tenants.length}; total size ${mb(sum(tenants.map((t) => t.databaseBytes)))} MB`,
    `- Files recorded in tenant tables: ${mb(sum(tenants.map((t) => storage(t))))} MB (R2's own totals are in the Cloudflare dashboard)`,
    `- Placement: ${entries(tally(master.workspaces, (w) => w.placement))}`,
    `- Partners: ${master.partners}; partner-managed workspaces: ${partnerManaged}`,
    `- Credit balances: ${master.credits.workspacesWithBalance} workspaces, ${master.credits.totalBalance} in total`,
    `- Database moves by status: ${entries(master.databaseMoves)}`,
    '',
  ];
}

function ssoLines(inv: GlobalInventory): string[] {
  const on = inv.master.sso.filter((s) => s.enabled);
  const named = on.map((s) => s.workspaceId + ' (' + (s.provider ?? '?') + ')');
  const list = named.length > 0 ? ': ' + named.join(', ') : '';
  const lines = [`1. **SSO.** ${on.length} workspace(s) with SSO enabled${list}.`];
  const saml = inv.clerk?.samlConnections;
  if (saml) {
    const enterprise = inv.clerk?.withEnterpriseAccount ?? 0;
    lines.push(`   Clerk SAML connections: ${saml.total} (${saml.active} active); users with an enterprise account: ${enterprise}.`);
  }
  return lines;
}

function clerkLine(clerk: ClerkInventory | null): string {
  if (!clerk) return '2. **Clerk.** Not read (no `CLERK_SECRET_KEY`, or `--skip-clerk`).';
  return (
    `2. **Clerk.** ${clerk.users} users: ${clerk.withPassword} with a password, ${clerk.withTotp} with TOTP, ` +
    `${clerk.withBackupCodes} with backup codes, ${clerk.withPasskeys} with passkeys, ${clerk.banned} banned. ` +
    `Social links: ${entries(clerk.externalProviders)}.`
  );
}

function mailStoreLine(inv: GlobalInventory): string {
  if (!inv.mailStoreChecked) {
    return '4. **Mailbox store modes.** Not read (set `MAIL_STORE_ADMIN_URL`, `OUTBOUND_ADMIN_SECRET`, `MAIL_STORE_ADMIN_EMAIL`).';
  }
  const modes = mergeCounts(inv.workspaces.map((w) => w.mailStoreModes ?? {}));
  const objectBacked = inv.workspaces
    .filter((w) => (w.mailStoreModes?.object ?? 0) + (w.mailStoreModes?.['object-only'] ?? 0) > 0)
    .map((w) => w.id);
  const list = objectBacked.length > 0 ? objectBacked.join(', ') : 'none';
  return `4. **Mailbox store modes.** ${entries(modes)}. Workspaces with mailboxes in Durable Objects: ${list}.`;
}

function portalsLine(inv: GlobalInventory): string {
  const commerce = inv.workspaces.filter((w) => w.tenant?.portals.commercePortalEnabled).map((w) => w.id);
  const project = inv.workspaces.filter((w) => (w.tenant?.portals.projectPortalStakeholders ?? 0) > 0).map((w) => w.id);
  return (
    `6. **Portals.** Commerce portal enabled in ${commerce.length} workspace(s)${idList(commerce)}; ` +
    `project portal stakeholders in ${project.length}${idList(project)}. The sites renderer has no backend to check.`
  );
}

function plansLines(master: MasterInventory, live: WorkspaceRow[]): string[] {
  const byPlan = entries(tally(live, (w) => w.planSlug ?? '(none)'));
  const byStatus = entries(tally(live, (w) => w.subscriptionStatus ?? '(none)'));
  const stripe = live.filter((w) => w.hasStripeSubscription).length;
  const lines = [`7. **Plans.** Workspaces by plan: ${byPlan}. By subscription status: ${byStatus}. With a Stripe subscription: ${stripe}.`];
  for (const p of master.plans) {
    const name = p.slug ?? p.id;
    lines.push(`   - \`${name}\`: ${p.currency ?? '?'} ${p.priceMonthly}/month, ${p.priceYearly}/year, ${p.pricePerUser}/user`);
  }
  return lines;
}

function apiLine(inv: GlobalInventory): string {
  const users = inv.workspaces
    .filter((w) => (w.tenant?.apiKeys.workspaceKeysUsed30d ?? 0) + (w.tenant?.apiKeys.personalKeysUsed30d ?? 0) > 0)
    .map((w) => w.id);
  const oauth = inv.clerk?.oauthApplications ?? 'not read';
  return (
    `8. **API and MCP.** Workspaces with an API key used in the last 30 days: ${users.length}${idList(users)}. ` +
    `WeldApps tokens used in 30 days: ${inv.master.weldApps.tokensUsed30d}. Clerk OAuth applications (MCP clients): ${oauth}.`
  );
}

function openQuestionsSection(inv: GlobalInventory, live: WorkspaceRow[]): string[] {
  const placed = inv.master.workspaces.filter((w) => w.placement !== 'none');
  const regions = tally(placed, (w) => w.region ?? '(unknown)');
  return [
    '## Open questions',
    '',
    ...ssoLines(inv),
    clerkLine(inv.clerk),
    '3. **DNSSEC.** Not covered here.',
    mailStoreLine(inv),
    `5. **Regions.** ${entries(regions)}.`,
    portalsLine(inv),
    ...plansLines(inv.master, live),
    apiLine(inv),
    '',
  ];
}

function whatMovesSection(master: MasterInventory, tenants: TenantInventory[]): string[] {
  const total = (pick: (t: TenantInventory) => number): number => sum(tenants.map(pick));
  const integrations = mergeCounts(
    tenants.flatMap((t) => t.integrations.map((i) => ({ [i.provider + ' (' + i.status + ')']: i.count }))),
  );
  const domains = total((t) => t.helpcenter.customDomains);
  const verified = total((t) => t.helpcenter.customDomainsVerified);
  return [
    '## What else moves',
    '',
    `- Custom mail domains: ${total((t) => t.mail.customDomains)}; free weldmail addresses: ${total((t) => t.mail.weldmailAddresses)}; ` +
      `mailboxes: ${total((t) => t.mail.accounts)}; messages (estimate): ${total((t) => t.mail.messagesEstimate)}`,
    `- Help center custom domains: ${domains} (${verified} verified); registry: ${entries(master.helpcenterDomains)}`,
    `- Phone numbers: ${entries(mergeCounts(tenants.map((t) => t.phoneNumbers)))}`,
    `- Paid WeldApps installs: ${master.weldApps.paidInstalls}; WeldApps OAuth clients: ${master.weldApps.oauthClients}`,
    `- Connected integrations: ${entries(integrations)}`,
    `- Pending scheduled work: ${entries(mergeCounts(tenants.map((t) => t.pending)))}`,
    '',
  ];
}

const INACTIVE_STATUS = /error|inactive|disconnected|revoked/i;

function tenantCells(t: TenantInventory | null): string[] {
  if (!t) return ['—', '—', '—', '—', '0', '0', '—'];
  const live = t.integrations.filter((i) => !INACTIVE_STATUS.test(i.status));
  return [
    mb(t.databaseBytes),
    mb(storage(t)),
    String(t.mail.customDomains),
    String(t.helpcenter.customDomains),
    String(sum(Object.values(t.phoneNumbers))),
    String(sum(live.map((i) => i.count))),
    String(t.apiKeys.workspaceKeysUsed30d + t.apiKeys.personalKeysUsed30d),
  ];
}

function workspaceRow(w: WorkspaceReport, m: WorkspaceRow | undefined): string {
  const placement = m ? [m.placement, m.region].filter(Boolean).join(', ') : '—';
  const errors = (w.tenant?.errors.length ?? 0) + (w.tenantSkipped ? 1 : 0);
  const cells = [
    '`' + w.id + '`',
    m?.planSlug ?? '—',
    workspaceState(m),
    placement,
    String(m?.membersActive ?? 0),
    ...tenantCells(w.tenant),
    errors > 0 ? String(errors) : '',
  ];
  return `| ${cells.join(' | ')} |`;
}

function errorsSection(inv: GlobalInventory): string[] {
  const errors = [...inv.master.errors.map((e) => `master: ${e}`), ...(inv.clerk?.errors ?? []).map((e) => `clerk: ${e}`)];
  for (const w of inv.workspaces) {
    if (w.tenantSkipped) errors.push(`${w.id}: ${w.tenantSkipped}`);
    for (const e of w.tenant?.errors ?? []) errors.push(`${w.id}: ${e}`);
  }
  return ['## Errors', '', ...(errors.length > 0 ? errors.map((e) => `- ${e}`) : ['None.']), ''];
}

/** The report as Markdown: totals, the answers to the plan's open questions, then one row per workspace. */
export function formatInventoryReport(inv: GlobalInventory): string {
  const byId = new Map(inv.master.workspaces.map((w) => [w.id, w]));
  const live = inv.master.workspaces.filter((w) => w.isActive && !w.deleted);
  const tenants = inv.workspaces.map((w) => w.tenant).filter((t): t is TenantInventory => t !== null);
  return [
    '# Global inventory',
    '',
    `Generated ${inv.generatedAt}. Read-only; counts only, no names, addresses or domains.`,
    '',
    ...totalsSection(inv, tenants, live),
    ...openQuestionsSection(inv, live),
    ...whatMovesSection(inv.master, tenants),
    '## Workspaces',
    '',
    '| Workspace | Plan | State | Placement | Members | DB MB | Files MB | Mail domains | Help center domains | Phones | Integrations | API keys used 30d | Errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...inv.workspaces.map((w) => workspaceRow(w, byId.get(w.id))),
    '',
    ...errorsSection(inv),
  ].join('\n');
}
