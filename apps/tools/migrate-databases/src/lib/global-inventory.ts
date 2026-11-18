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
  return value === null || value === undefined ? null : String(value);
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
        placement: !hasDatabase ? 'none' : r.shared_project_id ? 'shared' : 'dedicated',
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

  const integrations: IntegrationRow[] = [];
  for (const source of INTEGRATION_SOURCES) {
    const rows = await probe(errors, source.table, [] as Record<string, unknown>[], () =>
      query(
        `select ${source.provider} as provider, ${source.status} as status, count(*) as n
           from ${source.table} where ${source.where} group by 1, 2`,
      ),
    );
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
      for (const user of page) {
        out.users += 1;
        if (user.password_enabled) out.withPassword += 1;
        if (user.totp_enabled) out.withTotp += 1;
        if (user.backup_code_enabled) out.withBackupCodes += 1;
        if (user.two_factor_enabled) out.withTwoFactor += 1;
        if (user.banned) out.banned += 1;
        if ((user.passkeys?.length ?? 0) > 0) out.withPasskeys += 1;
        if ((user.saml_accounts?.length ?? 0) + (user.enterprise_accounts?.length ?? 0) > 0) out.withEnterpriseAccount += 1;
        for (const provider of new Set((user.external_accounts ?? []).map((a) => a.provider ?? '(unknown)'))) {
          out.externalProviders[provider] = (out.externalProviders[provider] ?? 0) + 1;
        }
      }
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
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
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
const entries = (map: Record<string, number>): string =>
  Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || '—';

function storage(t: TenantInventory | null): number {
  return t ? t.storageBytes.files + t.storageBytes.projectFiles + t.storageBytes.mailAttachments : 0;
}

function mergeCounts(maps: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const map of maps) for (const [k, v] of Object.entries(map)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** The report as Markdown: totals, the answers to the plan's open questions, then one row per workspace. */
export function formatInventoryReport(inv: GlobalInventory): string {
  const { master } = inv;
  const byId = new Map(master.workspaces.map((w) => [w.id, w]));
  const live = master.workspaces.filter((w) => w.isActive && !w.deleted);
  const tenants = inv.workspaces.map((w) => w.tenant).filter((t): t is TenantInventory => t !== null);
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(`# Global inventory`, '', `Generated ${inv.generatedAt}. Read-only; counts only, no names, addresses or domains.`, '');

  push('## Totals', '');
  push(`- Workspaces: ${master.workspaces.length} (${live.length} active and not deleted)`);
  push(`- Users: ${master.users.total} (${master.users.active} active)`);
  push(`- Tenant databases read: ${tenants.length}; total size ${mb(sum(tenants.map((t) => t.databaseBytes)))} MB`);
  push(`- Files recorded in tenant tables: ${mb(sum(tenants.map((t) => storage(t))))} MB (R2's own totals are in the Cloudflare dashboard)`);
  push(`- Placement: ${entries(mergeCounts(master.workspaces.map((w) => ({ [w.placement]: 1 }))))}`);
  push(`- Partners: ${master.partners}; partner-managed workspaces: ${master.workspaces.filter((w) => w.partnerManaged).length}`);
  push(`- Credit balances: ${master.credits.workspacesWithBalance} workspaces, ${master.credits.totalBalance} in total`);
  push(`- Database moves by status: ${entries(master.databaseMoves)}`, '');

  push('## Open questions', '');
  const ssoOn = master.sso.filter((s) => s.enabled);
  push(`1. **SSO.** ${ssoOn.length} workspace(s) with SSO enabled${ssoOn.length ? `: ${ssoOn.map((s) => `${s.workspaceId} (${s.provider ?? '?'})`).join(', ')}` : ''}.`);
  if (inv.clerk?.samlConnections) {
    push(`   Clerk SAML connections: ${inv.clerk.samlConnections.total} (${inv.clerk.samlConnections.active} active); users with an enterprise account: ${inv.clerk.withEnterpriseAccount}.`);
  }
  if (inv.clerk) {
    const c = inv.clerk;
    push(
      `2. **Clerk.** ${c.users} users: ${c.withPassword} with a password, ${c.withTotp} with TOTP, ${c.withBackupCodes} with backup codes, ` +
        `${c.withPasskeys} with passkeys, ${c.banned} banned. Social links: ${entries(c.externalProviders)}.`,
    );
  } else {
    push('2. **Clerk.** Not read (no `CLERK_SECRET_KEY`, or `--skip-clerk`).');
  }
  push('3. **DNSSEC.** Not covered here.');
  if (inv.mailStoreChecked) {
    const modes = mergeCounts(inv.workspaces.map((w) => w.mailStoreModes ?? {}));
    const objectBacked = inv.workspaces.filter((w) => (w.mailStoreModes?.object ?? 0) + (w.mailStoreModes?.['object-only'] ?? 0) > 0);
    push(`4. **Mailbox store modes.** ${entries(modes)}. Workspaces with mailboxes in Durable Objects: ${objectBacked.map((w) => w.id).join(', ') || 'none'}.`);
  } else {
    push('4. **Mailbox store modes.** Not read (set `MAIL_STORE_ADMIN_URL`, `OUTBOUND_ADMIN_SECRET`, `MAIL_STORE_ADMIN_EMAIL`).');
  }
  const regions = mergeCounts(master.workspaces.filter((w) => w.placement !== 'none').map((w) => ({ [w.region ?? '(unknown)']: 1 })));
  push(`5. **Regions.** ${entries(regions)}.`);
  const commerce = inv.workspaces.filter((w) => w.tenant?.portals.commercePortalEnabled);
  const project = inv.workspaces.filter((w) => (w.tenant?.portals.projectPortalStakeholders ?? 0) > 0);
  push(
    `6. **Portals.** Commerce portal enabled in ${commerce.length} workspace(s)${commerce.length ? ` (${commerce.map((w) => w.id).join(', ')})` : ''}; ` +
      `project portal stakeholders in ${project.length}${project.length ? ` (${project.map((w) => w.id).join(', ')})` : ''}. The sites renderer has no backend to check.`,
  );
  push(`7. **Plans.** Workspaces by plan: ${entries(mergeCounts(live.map((w) => ({ [w.planSlug ?? '(none)']: 1 }))))}. ` +
    `By subscription status: ${entries(mergeCounts(live.map((w) => ({ [w.subscriptionStatus ?? '(none)']: 1 }))))}. ` +
    `With a Stripe subscription: ${live.filter((w) => w.hasStripeSubscription).length}.`);
  for (const p of master.plans) {
    push(`   - \`${p.slug ?? p.id}\`: ${p.currency ?? '?'} ${p.priceMonthly}/month, ${p.priceYearly}/year, ${p.pricePerUser}/user`);
  }
  const apiUsers = inv.workspaces.filter((w) => (w.tenant?.apiKeys.workspaceKeysUsed30d ?? 0) + (w.tenant?.apiKeys.personalKeysUsed30d ?? 0) > 0);
  push(
    `8. **API and MCP.** Workspaces with an API key used in the last 30 days: ${apiUsers.length}${apiUsers.length ? ` (${apiUsers.map((w) => w.id).join(', ')})` : ''}. ` +
      `WeldApps tokens used in 30 days: ${master.weldApps.tokensUsed30d}. Clerk OAuth applications (MCP clients): ${inv.clerk?.oauthApplications ?? 'not read'}.`,
    '',
  );

  push('## What else moves', '');
  push(`- Custom mail domains: ${sum(tenants.map((t) => t.mail.customDomains))}; free weldmail addresses: ${sum(tenants.map((t) => t.mail.weldmailAddresses))}; mailboxes: ${sum(tenants.map((t) => t.mail.accounts))}; messages (estimate): ${sum(tenants.map((t) => t.mail.messagesEstimate))}`);
  push(`- Help center custom domains: ${sum(tenants.map((t) => t.helpcenter.customDomains))} (${sum(tenants.map((t) => t.helpcenter.customDomainsVerified))} verified); registry: ${entries(master.helpcenterDomains)}`);
  push(`- Phone numbers: ${entries(mergeCounts(tenants.map((t) => t.phoneNumbers)))}`);
  push(`- Paid WeldApps installs: ${master.weldApps.paidInstalls}; WeldApps OAuth clients: ${master.weldApps.oauthClients}`);
  const integrationTotals = mergeCounts(tenants.flatMap((t) => t.integrations.map((i) => ({ [`${i.provider} (${i.status})`]: i.count }))));
  push(`- Connected integrations: ${entries(integrationTotals)}`);
  push(`- Pending scheduled work: ${entries(mergeCounts(tenants.map((t) => t.pending)))}`, '');

  push('## Workspaces', '');
  push('| Workspace | Plan | State | Placement | Members | DB MB | Files MB | Mail domains | Help center domains | Phones | Integrations | API keys used 30d | Errors |');
  push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const w of inv.workspaces) {
    const m = byId.get(w.id);
    const t = w.tenant;
    const state = m ? (m.deleted ? 'deleted' : m.deletionScheduled ? 'deleting' : m.isActive ? 'active' : 'inactive') : '?';
    const phones = t ? sum(Object.values(t.phoneNumbers)) : 0;
    const integrations = t ? sum(t.integrations.filter((i) => !/error|inactive|disconnected|revoked/i.test(i.status)).map((i) => i.count)) : 0;
    const errors = (t?.errors.length ?? 0) + (w.tenantSkipped ? 1 : 0);
    push(
      `| \`${w.id}\` | ${m?.planSlug ?? '—'} | ${state} | ${m ? `${m.placement}${m.region ? `, ${m.region}` : ''}` : '—'} | ${m?.membersActive ?? 0} | ` +
        `${t ? mb(t.databaseBytes) : '—'} | ${t ? mb(storage(t)) : '—'} | ${t?.mail.customDomains ?? '—'} | ${t?.helpcenter.customDomains ?? '—'} | ` +
        `${phones} | ${integrations} | ${t ? t.apiKeys.workspaceKeysUsed30d + t.apiKeys.personalKeysUsed30d : '—'} | ${errors || ''} |`,
    );
  }
  push('');

  const allErrors = [
    ...master.errors.map((e) => `master: ${e}`),
    ...(inv.clerk?.errors ?? []).map((e) => `clerk: ${e}`),
    ...inv.workspaces.flatMap((w) => [
      ...(w.tenantSkipped ? [`${w.id}: ${w.tenantSkipped}`] : []),
      ...(w.tenant?.errors ?? []).map((e) => `${w.id}: ${e}`),
    ]),
  ];
  push('## Errors', '', ...(allErrors.length ? allErrors.map((e) => `- ${e}`) : ['None.']), '');
  return lines.join('\n');
}
