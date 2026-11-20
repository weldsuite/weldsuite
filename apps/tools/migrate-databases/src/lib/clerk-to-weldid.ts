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
 * - Users the export has and Clerk no longer does (deleted, or removed by an
 *   admin, since the export): the Backend API decides who is imported, so
 *   nobody comes back with an old password. The report lists their ids.
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

/** Characters that end an unquoted field. */
const FIELD_END = new Set([',', '\r', '\n']);

/** An unquoted run from `start` up to a comma, a line break or the end: its text and where it stops. */
function readUnquoted(body: string, start: number): [string, number] {
  let end = start;
  while (end < body.length && !FIELD_END.has(body[end])) end += 1;
  return [body.slice(start, end), end];
}

/**
 * The field at `start`: its text, and the index of what ends it (a comma, a
 * line break or the end). A quoted field takes `""` for a quote and may hold
 * commas and line breaks.
 */
function readField(body: string, start: number): [string, number] {
  if (body[start] !== '"') return readUnquoted(body, start);
  let text = '';
  let from = start + 1;
  for (;;) {
    const close = body.indexOf('"', from);
    if (close < 0) throw new Error('CSV: a quoted field never ends');
    text += body.slice(from, close);
    if (body[close + 1] !== '"') {
      const [rest, end] = readUnquoted(body, close + 1);
      return [text + rest, end];
    }
    text += '"';
    from = close + 2;
  }
}

/** RFC 4180: quoted fields with `""` for a quote, CRLF or LF, a final newline optional, a BOM ignored. */
export function parseCsv(text: string): string[][] {
  const body = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let at = 0;
  while (at < body.length) {
    const [value, end] = readField(body, at);
    row.push(value);
    if (body[end] === ',') {
      at = end + 1;
      continue;
    }
    rows.push(row);
    row = [];
    at = end + (body[end] === '\r' && body[end + 1] === '\n' ? 2 : 1);
  }
  // A comma at the very end leaves one empty field.
  if (row.length > 0) rows.push([...row, '']);
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

/** What the conversion did, in counts; ids only of users left out. */
export interface ConvertReport {
  /** Clerk's users now (the Backend API's). */
  users: number;
  accounts: number;
  emailVerified: number;
  withDigest: number;
  totp: number;
  links: Record<string, number>;
  disabled: number;
  /** Users without a usable address: left out (ids, never addresses). */
  noEmail: string[];
  /**
   * Users in the export whom Clerk no longer has (deleted, or removed by an
   * admin, since the export): left out, so nobody comes back with an old
   * password. Ids, for the operator to look at.
   */
  onlyInExport: string[];
  /** Users who signed up after the export: imported without a password or key. */
  onlyInApi: number;
  /** Accounts imported bare because Clerk never proved their address, though they had a password, a key or a link. */
  unverifiedBare: number;
  /** Passwords the export doesn't carry as bcrypt: these people use "forgot password" or an email code. */
  digestNotBcrypt: number;
  digestNotExported: number;
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

function emptyReport(): ConvertReport {
  return {
    users: 0,
    accounts: 0,
    emailVerified: 0,
    withDigest: 0,
    totp: 0,
    links: {},
    disabled: 0,
    noEmail: [],
    onlyInExport: [],
    onlyInApi: 0,
    unverifiedBare: 0,
    digestNotBcrypt: 0,
    digestNotExported: 0,
    totpNotBase32: 0,
    totpNotExported: 0,
    linksLeftOut: {},
    passkeys: 0,
    backupCodes: 0,
    enterpriseAccounts: 0,
    clerkHostedPictures: 0,
  };
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

/** `{ [key]: value }` for a non-empty value (trimmed), else nothing: for spreading optional fields. */
function field<K extends string>(key: K, value: string | null | undefined): Partial<Record<K, string>> {
  const text = value?.trim();
  return text ? ({ [key]: text } as Partial<Record<K, string>>) : {};
}

function primaryAddress(user: ClerkApiUser): { email: string; verified: boolean } | null {
  const address = user.email_addresses?.find((a) => a.id === user.primary_email_address_id);
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

/** Passkeys, backup codes and SAML or enterprise accounts: counted, never imported. */
function tallyFactors(user: ClerkApiUser, report: ConvertReport): void {
  if ((user.passkeys?.length ?? 0) > 0) report.passkeys += 1;
  if (user.backup_code_enabled) report.backupCodes += 1;
  if ((user.saml_accounts?.length ?? 0) + (user.enterprise_accounts?.length ?? 0) > 0) report.enterpriseAccounts += 1;
}

/** The export's bcrypt digest of the user, when it has one WeldID takes. */
function passwordOf(user: ClerkApiUser, row: ClerkExportRow | undefined, report: ConvertReport): string | undefined {
  if (!row?.passwordDigest) {
    if (user.password_enabled) report.digestNotExported += 1;
    return undefined;
  }
  if (row.passwordHasher === 'bcrypt' && BCRYPT.test(row.passwordDigest)) return row.passwordDigest;
  report.digestNotBcrypt += 1;
  return undefined;
}

/** The export's authenticator key of the user, as base32 of 128 bits or more. */
function totpOf(user: ClerkApiUser, row: ClerkExportRow | undefined, report: ConvertReport): string | undefined {
  const key = (row?.totpSecret ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (key === '') {
    if (user.totp_enabled) report.totpNotExported += 1;
    return undefined;
  }
  if (BASE32_KEY.test(key)) return key;
  report.totpNotBase32 += 1;
  return undefined;
}

type Link = NonNullable<WeldIdAccount['links']>[number];

/** The Google and Apple links of `user`, with what's left out counted. */
function linksOf(user: ClerkApiUser, options: ConvertOptions, report: ConvertReport): Link[] {
  const links: Link[] = [];
  for (const account of user.external_accounts ?? []) {
    const status = account.verification?.status;
    if (status && status !== 'verified') continue;
    const provider = (account.provider ?? (account.google_id ? 'google' : '')).replace(/^oauth_/, '');
    const subject = (account.provider_user_id ?? account.google_id ?? '').trim();
    if (subject === '') {
      bump(report.linksLeftOut, `${provider || 'unknown'} (no subject)`);
    } else if (provider === 'google' || (provider === 'apple' && options.appleLinks)) {
      links.push({ provider, subject, ...field('email', account.email_address) });
    } else {
      bump(report.linksLeftOut, provider || 'unknown');
    }
  }
  return links;
}

/**
 * The password, key and links of `user`. Only with an address Clerk proved:
 * WeldID gives an unproven account to whoever proves the address, so it is
 * imported bare.
 */
function credentialsOf(
  user: ClerkApiUser,
  row: ClerkExportRow | undefined,
  verified: boolean,
  options: ConvertOptions,
  report: ConvertReport,
): { passwordHash?: string; totpSecret?: string; links: Link[] } {
  const passwordHash = passwordOf(user, row, report);
  const totpSecret = totpOf(user, row, report);
  const links = linksOf(user, options, report);
  if (verified || (!passwordHash && !totpSecret && links.length === 0)) return { passwordHash, totpSecret, links };
  report.unverifiedBare += 1;
  return { links: [] };
}

/** The user's own picture (not Clerk's default) when it is an https URL. */
function pictureOf(user: ClerkApiUser, report: ConvertReport): string | undefined {
  if (!user.has_image || !isHttps(user.image_url)) return undefined;
  const host = new URL(user.image_url).hostname;
  if (host === 'clerk.com' || host.endsWith('.clerk.com')) report.clerkHostedPictures += 1;
  return user.image_url;
}

/** One user's import line, or null (counted) when it has no address. */
function accountOf(
  user: ClerkApiUser,
  row: ClerkExportRow | undefined,
  options: ConvertOptions,
  report: ConvertReport,
): WeldIdAccount | null {
  if (!row) report.onlyInApi += 1;
  tallyFactors(user, report);
  const address = primaryAddress(user);
  if (!address) {
    report.noEmail.push(user.id);
    return null;
  }
  const { passwordHash, totpSecret, links } = credentialsOf(user, row, address.verified, options, report);
  return {
    id: user.id,
    email: address.email,
    ...field('givenName', user.first_name ?? row?.firstName),
    ...field('familyName', user.last_name ?? row?.lastName),
    ...field('picture', pictureOf(user, report)),
    emailVerified: address.verified,
    ...field('passwordHash', passwordHash),
    ...field('totpSecret', totpSecret),
    ...(links.length > 0 ? { links } : {}),
    ...(user.banned ? { disabled: true } : {}),
  };
}

function countAccount(account: WeldIdAccount, report: ConvertReport): void {
  report.accounts += 1;
  if (account.emailVerified) report.emailVerified += 1;
  if (account.passwordHash) report.withDigest += 1;
  if (account.totpSecret) report.totp += 1;
  for (const link of account.links ?? []) bump(report.links, link.provider);
  if (account.disabled) report.disabled += 1;
}

/**
 * One import line per Clerk user with an address, in the API's order. The
 * Backend API is read at the time of the run and decides who is imported
 * and how: the export only adds the digest and the key. A user the export
 * has and the API no longer does is left out (and listed in the report).
 */
export function toWeldIdAccounts(
  exported: Map<string, ClerkExportRow>,
  apiUsers: ClerkApiUser[],
  options: ConvertOptions = {},
): { accounts: WeldIdAccount[]; report: ConvertReport } {
  const report = emptyReport();
  const accounts: WeldIdAccount[] = [];
  for (const user of apiUsers) {
    report.users += 1;
    const account = accountOf(user, exported.get(user.id), options, report);
    if (account) {
      accounts.push(account);
      countAccount(account, report);
    }
  }
  const live = new Set(apiUsers.map((u) => u.id));
  report.onlyInExport = [...exported.keys()].filter((id) => !live.has(id));
  return { accounts, report };
}

/** The report as lines for the operator (counts; ids only of users left out). */
export function formatConvertReport(report: ConvertReport): string[] {
  const entries = (record: Record<string, number>) =>
    Object.entries(record)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none';
  const listed = (ids: string[]) => (ids.length > 0 ? ` (${ids.join(', ')})` : '');
  return [
    `Clerk users: ${report.users}; signed up after the export: ${report.onlyInApi}.`,
    `Import lines: ${report.accounts}; address proven: ${report.emailVerified}; disabled (banned): ${report.disabled}.`,
    `With a bcrypt password: ${report.withDigest}; an authenticator key: ${report.totp}; links: ${entries(report.links)}.`,
    `Left out: no address ${report.noEmail.length}${listed(report.noEmail)}; ` +
      `in the export but no longer in Clerk ${report.onlyInExport.length}${listed(report.onlyInExport)}.`,
    `Imported without what they had: address never proven ${report.unverifiedBare}; ` +
      `passwords not bcrypt ${report.digestNotBcrypt}, not in the export ${report.digestNotExported}; ` +
      `keys not base32 ${report.totpNotBase32}, not in the export ${report.totpNotExported}; ` +
      `links ${entries(report.linksLeftOut)}.`,
    `Set up again after the move: passkeys ${report.passkeys} users, backup codes ${report.backupCodes} users.`,
    `Users with a SAML or enterprise account: ${report.enterpriseAccounts}. Pictures on Clerk's host: ${report.clerkHostedPictures}.`,
  ];
}
