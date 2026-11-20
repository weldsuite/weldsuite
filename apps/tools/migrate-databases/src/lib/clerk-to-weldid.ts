/**
 * Global's Clerk users as WeldID import lines (`weldid admin user import`),
 * for phase 2 of Global's retirement (ADR OPS-025, `plans/retire-global-edition.md`
 * in weldsuite-documentation).
 *
 * Two sources, joined on the Clerk user id:
 * - the dashboard's user export (Settings › User exports, a CSV), the only
 *   place Clerk gives out the password digest (`password_digest`,
 *   `password_hasher`) and the authenticator key (`totp_secret`);
 * - the Backend API (`GET /v1/users`), for each address's verification state
 *   and the social accounts (`external_accounts`), which the CSV doesn't have.
 *
 * Each account keeps its Clerk id (`user_…`), which WeldID issues as `sub`,
 * so none of the platform's user-id columns change. What comes along:
 * - the primary address, and whether Clerk had proven it;
 * - the bcrypt digest, which WeldID replaces with Argon2id at the first sign-in;
 * - the authenticator key;
 * - Google links, by Google's subject (the same for every client), and Apple
 *   links when asked (`appleLinks`: Apple's subject is the same only within
 *   one developer team, so only when Clerk's production instance signed in
 *   with WeldSuite's own Apple credentials and WeldID uses the same team).
 *
 * What doesn't, and why:
 * - Microsoft links: Microsoft's subject differs per client, and Clerk keeps
 *   no tenant. Those people sign in with Microsoft, confirm their address with
 *   one emailed code, and WeldID links it (it never links by email alone).
 * - Passkeys and backup codes: Clerk exports neither. Those people set them up again.
 * - Credentials of an account whose address Clerk never proved: WeldID gives
 *   such an account to whoever proves the address, so it is imported bare.
 *
 * Nothing here logs an address, a digest or a key: the report holds counts,
 * and ids only for accounts that can't be imported.
 */

/** The bcrypt variants WeldID verifies, with a two-digit cost and 53 characters of salt and digest. */
const BCRYPT = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;
/** RFC 4648 base32 of at least 128 bits (26 characters), optional `=` padding at the end. */
const BASE32_KEY = /^[A-Z2-7]{26,}=*$/;

// ---------------------------------------------------------------------------
// The CSV
// ---------------------------------------------------------------------------

/** RFC 4180: quoted fields with `""` for a quote, CRLF or LF, a final newline optional. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error('CSV: a quoted field never ends');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** One user of the export. */
export interface ClerkExportRow {
  id: string;
  firstName: string;
  lastName: string;
  primaryEmail: string;
  verifiedEmails: string[];
  unverifiedEmails: string[];
  totpSecret: string;
  passwordDigest: string;
  passwordHasher: string;
}

/**
 * A cell without surrounding whitespace. Clerk's dashboard CSV puts a TAB
 * before a value that starts with `=`, `+`, `-` or `@` (so a spreadsheet
 * doesn't run it as a formula); trimming takes it off too.
 */
function unescapeCell(value: string): string {
  return value.trim();
}

/** A cell with several values: `|` or `,` between them, or a JSON array. */
function splitCell(value: string): string[] {
  const text = unescapeCell(value);
  if (text === '') return [];
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      // Not JSON after all: split it like any other cell.
    }
  }
  return text
    .split(/[|,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * The export's users by id. Columns are found by their header name (Clerk
 * has changed their order); `id` and `primary_email_address` must be there.
 */
export function readClerkExport(text: string): Map<string, ClerkExportRow> {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('the export is empty');
  const index = new Map(header.map((name, i) => [unescapeCell(name).toLowerCase(), i]));
  for (const required of ['id', 'primary_email_address']) {
    if (!index.has(required)) throw new Error(`the export has no ${required} column; is it Clerk's user export?`);
  }
  const cell = (row: string[], name: string): string => {
    const i = index.get(name);
    return i === undefined ? '' : unescapeCell(row[i] ?? '');
  };
  const out = new Map<string, ClerkExportRow>();
  for (const row of rows) {
    const id = cell(row, 'id');
    if (id === '') continue;
    out.set(id, {
      id,
      firstName: cell(row, 'first_name'),
      lastName: cell(row, 'last_name'),
      primaryEmail: cell(row, 'primary_email_address'),
      verifiedEmails: splitCell(cell(row, 'verified_email_addresses')),
      unverifiedEmails: splitCell(cell(row, 'unverified_email_addresses')),
      totpSecret: cell(row, 'totp_secret'),
      passwordDigest: cell(row, 'password_digest'),
      passwordHasher: cell(row, 'password_hasher').toLowerCase(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Backend API
// ---------------------------------------------------------------------------

/** The parts of a Backend API user this reads. */
export interface ClerkApiUser {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{
    id?: string;
    email_address?: string;
    verification?: { status?: string | null } | null;
  }>;
  external_accounts?: Array<{
    provider?: string | null;
    provider_user_id?: string | null;
    /** Older Google accounts carry their subject here instead. */
    google_id?: string | null;
    email_address?: string | null;
    verification?: { status?: string | null } | null;
  }>;
  password_enabled?: boolean;
  totp_enabled?: boolean;
  backup_code_enabled?: boolean;
  banned?: boolean;
  has_image?: boolean;
  image_url?: string | null;
  passkeys?: unknown[];
  saml_accounts?: unknown[];
  enterprise_accounts?: unknown[];
}

const CLERK_API = 'https://api.clerk.com/v1';
const CLERK_PAGE = 500;

/** Every user, oldest first, from the Backend API. */
export async function fetchClerkUsers(secretKey: string, fetchFn: typeof fetch = fetch): Promise<ClerkApiUser[]> {
  const users: ClerkApiUser[] = [];
  for (let offset = 0; ; offset += CLERK_PAGE) {
    const res = await fetchFn(`${CLERK_API}/users?limit=${CLERK_PAGE}&offset=${offset}&order_by=created_at`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!res.ok) throw new Error(`Clerk /users: HTTP ${res.status}`);
    const page = (await res.json()) as ClerkApiUser[];
    users.push(...page);
    if (page.length < CLERK_PAGE) break;
  }
  return users;
}

// ---------------------------------------------------------------------------
// WeldID's import lines
// ---------------------------------------------------------------------------

/** One line of `weldid admin user import` (WeldID's `admin::cli::ImportedAccount`). */
export interface WeldIdAccount {
  id: string;
  email: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  emailVerified: boolean;
  passwordHash?: string;
  totpSecret?: string;
  links?: Array<{ provider: 'google' | 'apple'; subject: string; email?: string }>;
  disabled?: boolean;
}

export interface ConvertOptions {
  /** Import Apple links (only when Clerk and WeldID sign in with the same Apple developer team). */
  appleLinks?: boolean;
}

/** What the conversion did, in counts; ids only of accounts left out. */
export interface ConvertReport {
  users: number;
  accounts: number;
  emailVerified: number;
  passwords: number;
  totp: number;
  links: Record<string, number>;
  disabled: number;
  /** Accounts without a usable address: left out (ids, never addresses). */
  noEmail: string[];
  /** Users only in the CSV (deleted since the export?) or only in the API (signed up since?). */
  onlyInExport: number;
  onlyInApi: number;
  /** Accounts imported bare because Clerk never proved their address, though they had a password, a key or a link. */
  unverifiedBare: number;
  /** Passwords the export doesn't carry as bcrypt: these people use "forgot password" or an email code. */
  passwordNotBcrypt: number;
  passwordNotExported: number;
  /** Authenticator keys that aren't base32 of 128 bits or more, or that the export lacks: these people set one up again. */
  totpNotBase32: number;
  totpNotExported: number;
  /** Links left out, by provider: Microsoft always; Apple unless asked; any other provider. */
  linksLeftOut: Record<string, number>;
  /** Users who set up passkeys or backup codes again. */
  passkeys: number;
  backupCodes: number;
  /** Users with a SAML or enterprise account: their workspace needs SSO on WeldID. */
  enterpriseAccounts: number;
  /** Pictures on Clerk's image host: copy them before Clerk is closed. */
  clerkHostedPictures: number;
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function primaryAddress(user: ClerkApiUser | undefined): { email: string; verified: boolean } | null {
  const address = user?.email_addresses?.find((a) => a.id === user.primary_email_address_id);
  const email = address?.email_address?.trim();
  return email ? { email, verified: address?.verification?.status === 'verified' } : null;
}

function isHttps(url: string | null | undefined): url is string {
  try {
    return Boolean(url) && new URL(url as string).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The Google and Apple links of `user`, with what's left out counted. */
function linksOf(
  user: ClerkApiUser | undefined,
  options: ConvertOptions,
  report: ConvertReport,
): NonNullable<WeldIdAccount['links']> {
  const links: NonNullable<WeldIdAccount['links']> = [];
  for (const account of user?.external_accounts ?? []) {
    const status = account.verification?.status;
    if (status && status !== 'verified') continue;
    const provider = (account.provider ?? (account.google_id ? 'google' : '')).replace(/^oauth_/, '');
    const subject = (account.provider_user_id ?? account.google_id ?? '').trim();
    if (subject === '') {
      bump(report.linksLeftOut, `${provider || 'unknown'} (no subject)`);
      continue;
    }
    if (provider === 'google' || (provider === 'apple' && options.appleLinks)) {
      const email = account.email_address?.trim();
      links.push({ provider, subject, ...(email ? { email } : {}) });
    } else {
      bump(report.linksLeftOut, provider || 'unknown');
    }
  }
  return links;
}

/**
 * One import line per Clerk user that has an address: the API's users in
 * their order, then any the export has and the API doesn't. The API's view
 * wins where both say something (it is read at the time of the run).
 */
export function toWeldIdAccounts(
  exported: Map<string, ClerkExportRow>,
  apiUsers: ClerkApiUser[],
  options: ConvertOptions = {},
): { accounts: WeldIdAccount[]; report: ConvertReport } {
  const report: ConvertReport = {
    users: 0,
    accounts: 0,
    emailVerified: 0,
    passwords: 0,
    totp: 0,
    links: {},
    disabled: 0,
    noEmail: [],
    onlyInExport: 0,
    onlyInApi: 0,
    unverifiedBare: 0,
    passwordNotBcrypt: 0,
    passwordNotExported: 0,
    totpNotBase32: 0,
    totpNotExported: 0,
    linksLeftOut: {},
    passkeys: 0,
    backupCodes: 0,
    enterpriseAccounts: 0,
    clerkHostedPictures: 0,
  };
  const byId = new Map(apiUsers.map((u) => [u.id, u]));
  const ids = [...byId.keys(), ...[...exported.keys()].filter((id) => !byId.has(id))];
  const accounts: WeldIdAccount[] = [];

  for (const id of ids) {
    const api = byId.get(id);
    const row = exported.get(id);
    report.users += 1;
    if (!api) report.onlyInExport += 1;
    if (!row) report.onlyInApi += 1;
    if ((api?.passkeys?.length ?? 0) > 0) report.passkeys += 1;
    if (api?.backup_code_enabled) report.backupCodes += 1;
    if ((api?.saml_accounts?.length ?? 0) + (api?.enterprise_accounts?.length ?? 0) > 0) report.enterpriseAccounts += 1;

    const fromApi = primaryAddress(api);
    const email = fromApi?.email ?? row?.primaryEmail ?? '';
    if (email === '') {
      report.noEmail.push(id);
      continue;
    }
    const verified = fromApi
      ? fromApi.verified
      : Boolean(row?.verifiedEmails.some((v) => v.toLowerCase() === email.toLowerCase()));

    let passwordHash: string | undefined;
    if (row?.passwordDigest) {
      if (row.passwordHasher === 'bcrypt' && BCRYPT.test(row.passwordDigest)) passwordHash = row.passwordDigest;
      else report.passwordNotBcrypt += 1;
    } else if (api?.password_enabled) {
      report.passwordNotExported += 1;
    }

    let totpSecret: string | undefined;
    const key = (row?.totpSecret ?? '').replace(/[\s-]/g, '').toUpperCase();
    if (key !== '') {
      if (BASE32_KEY.test(key)) totpSecret = key;
      else report.totpNotBase32 += 1;
    } else if (api?.totp_enabled) {
      report.totpNotExported += 1;
    }

    let links = linksOf(api, options, report);
    if (!verified && (passwordHash || totpSecret || links.length > 0)) {
      report.unverifiedBare += 1;
      passwordHash = undefined;
      totpSecret = undefined;
      links = [];
    }

    const givenName = (api?.first_name ?? row?.firstName ?? '').trim();
    const familyName = (api?.last_name ?? row?.lastName ?? '').trim();
    const picture = api?.has_image && isHttps(api.image_url) ? api.image_url : undefined;
    if (picture && new URL(picture).hostname.endsWith('clerk.com')) report.clerkHostedPictures += 1;

    const account: WeldIdAccount = {
      id,
      email,
      ...(givenName ? { givenName } : {}),
      ...(familyName ? { familyName } : {}),
      ...(picture ? { picture } : {}),
      emailVerified: verified,
      ...(passwordHash ? { passwordHash } : {}),
      ...(totpSecret ? { totpSecret } : {}),
      ...(links.length > 0 ? { links } : {}),
      ...(api?.banned ? { disabled: true } : {}),
    };
    accounts.push(account);
    report.accounts += 1;
    if (verified) report.emailVerified += 1;
    if (passwordHash) report.passwords += 1;
    if (totpSecret) report.totp += 1;
    for (const link of links) bump(report.links, link.provider);
    if (account.disabled) report.disabled += 1;
  }
  return { accounts, report };
}

/** The report as lines for the operator (counts; ids only of accounts left out). */
export function formatConvertReport(report: ConvertReport): string[] {
  const entries = (record: Record<string, number>) =>
    Object.entries(record)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none';
  return [
    `Clerk users: ${report.users} (only in the export: ${report.onlyInExport}, only in the API: ${report.onlyInApi}).`,
    `Import lines: ${report.accounts}; address proven: ${report.emailVerified}; disabled (banned): ${report.disabled}.`,
    `With a bcrypt password: ${report.passwords}; an authenticator key: ${report.totp}; links: ${entries(report.links)}.`,
    `Left out: no address ${report.noEmail.length}${report.noEmail.length ? ` (${report.noEmail.join(', ')})` : ''}; ` +
      `imported bare (address never proven) ${report.unverifiedBare}; ` +
      `passwords not bcrypt ${report.passwordNotBcrypt}, not in the export ${report.passwordNotExported}; ` +
      `keys not base32 ${report.totpNotBase32}, not in the export ${report.totpNotExported}; ` +
      `links ${entries(report.linksLeftOut)}.`,
    `Set up again after the move: passkeys ${report.passkeys} users, backup codes ${report.backupCodes} users.`,
    `Users with a SAML or enterprise account: ${report.enterpriseAccounts}. Pictures on Clerk's host: ${report.clerkHostedPictures}.`,
  ];
}
