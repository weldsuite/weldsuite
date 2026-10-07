/**
 * Mail accounts as seen from outside the platform: the public API and the MCP
 * server.
 *
 * Read-only on purpose. Creating, connecting and configuring a mailbox stays in
 * the WeldMail UI. What lives here is the one shape any non-platform surface may
 * return, plus the sender-domain rule the public API sends under.
 *
 * The column projection is explicit and must stay that way: `mail_accounts`
 * holds `accessToken`, `refreshToken`, `apiKey` and `passwordHash`. A plain
 * `select()` returned to a caller would leak all four.
 */

import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { canOpenAccount, principalAccessCondition, type MailCaller } from './access';

const { mailAccounts, mailDomains } = schema;

type MailAccountRow = typeof mailAccounts.$inferSelect;

/** The columns any public surface may return. Never the credential columns. */
const PUBLIC_COLUMNS = {
  id: mailAccounts.id,
  name: mailAccounts.name,
  email: mailAccounts.email,
  displayName: mailAccounts.displayName,
  provider: mailAccounts.provider,
  status: mailAccounts.status,
  isDefault: mailAccounts.isDefault,
  isShared: mailAccounts.isShared,
  syncEnabled: mailAccounts.syncEnabled,
  syncStatus: mailAccounts.syncStatus,
  lastSyncAt: mailAccounts.lastSyncAt,
  dailySendLimit: mailAccounts.dailySendLimit,
  createdAt: mailAccounts.createdAt,
  updatedAt: mailAccounts.updatedAt,
};

export type PublicMailAccount = Pick<MailAccountRow, keyof typeof PUBLIC_COLUMNS> & {
  /** Whether the public API will send from this account (verified sender domain). */
  canSendViaApi: boolean;
};

/** The domain part of an address, lower-cased. Empty for a malformed address. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

/**
 * The verified WeldMail domains among `domains`, lower-cased.
 *
 * Verified means the domain's DNS (SPF/DKIM) passed in WeldMail, so mail sent
 * from it through Cloudflare authenticates. An address on a domain nobody
 * verified here (`gmail.com`, a customer's own domain that was never added)
 * would fail SPF/DMARC and land in spam or be rejected.
 */
export async function verifiedDomains(db: Database, domains: string[]): Promise<Set<string>> {
  const wanted = [...new Set(domains.filter(Boolean))];
  if (wanted.length === 0) return new Set();
  const rows = await db
    .select({ domainName: mailDomains.domainName })
    .from(mailDomains)
    .where(
      and(
        sql`LOWER(${mailDomains.domainName}) IN (${sql.join(
          wanted.map((d) => sql`${d}`),
          sql`, `,
        )})`,
        eq(mailDomains.dnsStatus, 'verified'),
        isNull(mailDomains.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.domainName.toLowerCase()));
}

/** Whether `email` is on a verified WeldMail domain of this workspace. */
export async function isSenderDomainVerified(db: Database, email: string): Promise<boolean> {
  const domain = emailDomain(email);
  if (!domain) return false;
  return (await verifiedDomains(db, [domain])).has(domain);
}

async function withSendability(
  db: Database,
  rows: Omit<PublicMailAccount, 'canSendViaApi'>[],
): Promise<PublicMailAccount[]> {
  const verified = await verifiedDomains(
    db,
    rows.map((r) => emailDomain(r.email)),
  );
  return rows.map((r) => ({ ...r, canSendViaApi: verified.has(emailDomain(r.email)) }));
}

export interface ListPublicAccountsFilters {
  search?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

/**
 * The caller's mailboxes, newest first, cursor-paginated by id. A workspace
 * principal sees shared mailboxes only.
 */
export async function listPublicMailAccounts(
  db: Database,
  caller: MailCaller,
  filters: ListPublicAccountsFilters,
): Promise<{ data: PublicMailAccount[]; hasMore: boolean; cursor: string | null; totalCount: number }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const conditions: SQL[] = [isNull(mailAccounts.deletedAt)!, await principalAccessCondition(db, caller)];
  if (filters.search) {
    const term = `%${filters.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conditions.push(
      or(ilike(mailAccounts.name, term), ilike(mailAccounts.email, term), ilike(mailAccounts.displayName, term))!,
    );
  }
  if (filters.status) {
    conditions.push(eq(mailAccounts.status, filters.status as MailAccountRow['status']));
  }

  const pageConditions = [...conditions];
  if (filters.cursor) {
    const [cur] = await db
      .select({ createdAt: mailAccounts.createdAt, id: mailAccounts.id })
      .from(mailAccounts)
      .where(eq(mailAccounts.id, filters.cursor))
      .limit(1);
    if (cur) {
      pageConditions.push(
        sql`(${mailAccounts.createdAt} < ${cur.createdAt} OR (${mailAccounts.createdAt} = ${cur.createdAt} AND ${mailAccounts.id} < ${cur.id}))`,
      );
    }
  }

  const [rows, [countRow]] = await Promise.all([
    db
      .select(PUBLIC_COLUMNS)
      .from(mailAccounts)
      .where(and(...pageConditions))
      .orderBy(desc(mailAccounts.createdAt), desc(mailAccounts.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(mailAccounts).where(and(...conditions)),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    data: await withSendability(db, page),
    hasMore,
    cursor: hasMore && page.length > 0 ? page[page.length - 1]!.id : null,
    totalCount: Number(countRow?.count ?? 0),
  };
}

/** One mailbox, or null when it does not exist or the caller may not open it. */
export async function getPublicMailAccount(
  db: Database,
  caller: MailCaller,
  id: string,
): Promise<PublicMailAccount | null> {
  if (!(await canOpenAccount(db, id, caller))) return null;
  const [row] = await db
    .select(PUBLIC_COLUMNS)
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!row) return null;
  const [account] = await withSendability(db, [row]);
  return account ?? null;
}
