/**
 * WeldPass password manager — request schemas and the small pure helpers that
 * pass-api, the platform and the browser extension all have to agree on
 * (what counts as a weak password, which host a URL belongs to). Zod v3.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Vaults and members
// ---------------------------------------------------------------------------

export const weldpassVaultRoleSchema = z.enum(['viewer', 'editor', 'manager']);
export type WeldPassVaultRole = z.infer<typeof weldpassVaultRoleSchema>;

export const createVaultSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullish(),
});

export const updateVaultSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2000).nullish(),
});

export const addVaultMemberSchema = z.object({
  userId: z.string().min(1).max(255),
  role: weldpassVaultRoleSchema,
});

export const updateVaultMemberSchema = z.object({ role: weldpassVaultRoleSchema });

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const weldpassItemTypeSchema = z.enum(['login', 'note', 'card']);
export type WeldPassItemType = z.infer<typeof weldpassItemTypeSchema>;

const title = z.string().trim().min(1).max(200);
const notes = z.string().max(20_000).default('');

export const loginFieldsSchema = z.object({
  username: z.string().max(255).default(''),
  password: z.string().max(4096).default(''),
  /** A base32 secret or a full `otpauth://` URI. Empty when 2FA is not stored. */
  totp: z.string().trim().max(2048).default(''),
  notes,
});

export const noteFieldsSchema = z.object({
  content: z.string().max(100_000).default(''),
});

export const cardFieldsSchema = z.object({
  cardholder: z.string().trim().max(255).default(''),
  number: z.string().trim().max(40).default(''),
  /** As printed on the card, e.g. "08/29". */
  expiry: z.string().trim().max(10).default(''),
  cvc: z.string().trim().max(10).default(''),
  notes,
});

export type WeldPassLoginFields = z.infer<typeof loginFieldsSchema>;
export type WeldPassNoteFields = z.infer<typeof noteFieldsSchema>;
export type WeldPassCardFields = z.infer<typeof cardFieldsSchema>;

/**
 * A whole item. Saving always sends every field: the fields are sealed as one
 * document, so there is no such thing as patching only the password.
 */
export const itemInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('login'),
    title,
    url: z.string().trim().max(2048).nullish(),
    fields: loginFieldsSchema,
  }),
  z.object({ type: z.literal('note'), title, fields: noteFieldsSchema }),
  z.object({ type: z.literal('card'), title, fields: cardFieldsSchema }),
]);

export type WeldPassItemInput = z.infer<typeof itemInputSchema>;
export type WeldPassItemFields = WeldPassItemInput['fields'];

export const moveItemSchema = z.object({ targetVaultId: z.string().min(1).max(30) });
export const restoreItemSchema = z.object({ version: z.number().int().min(1) });

export const importFormatSchema = z.enum([
  'auto',
  'lastpass',
  'nordpass',
  '1password',
  'bitwarden',
  'chrome',
]);
export type WeldPassImportFormat = z.infer<typeof importFormatSchema>;

export const importItemsSchema = z.object({
  /** Raw CSV text as exported by the other password manager. */
  content: z.string().max(5 * 1024 * 1024),
  format: importFormatSchema.default('auto'),
});

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/**
 * The hostname a URL belongs to, lower-cased and without a leading "www.".
 * Tolerates what people actually type ("example.com/login"), and returns null
 * for anything that is not a web address rather than throwing.
 */
export function hostOf(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return host.includes('.') || host === 'localhost' ? host.slice(0, 255) : null;
}

/**
 * Whether a login saved for `itemHost` belongs on a page at `pageHost`: the
 * same host, or one is a subdomain of the other (`accounts.example.com` and
 * `example.com`). There is no public-suffix list here, so the shared part has
 * to be at least two labels — `co.uk` alone never matches anything.
 */
export function hostsMatch(itemHost: string, pageHost: string): boolean {
  if (itemHost === pageHost) return true;
  const [short, long] =
    itemHost.length < pageHost.length ? [itemHost, pageHost] : [pageHost, itemHost];
  return short.split('.').length >= 2 && long.endsWith(`.${short}`);
}

// ---------------------------------------------------------------------------
// Password strength
// ---------------------------------------------------------------------------

export type PasswordStrength = 'weak' | 'fair' | 'strong';

/** The passwords attackers try first. Matched case-insensitively. */
const COMMON_PASSWORDS = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', '111111', '000000', '123123',
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty', 'qwerty123',
  'qwertyuiop', 'azerty', 'abc123', 'letmein', 'welcome', 'welcome1', 'welcome123', 'admin',
  'admin123', 'administrator', 'root', 'iloveyou', 'monkey', 'dragon', 'football', 'baseball',
  'master', 'sunshine', 'princess', 'login', 'changeme', 'secret', 'trustno1', 'superman',
  'batman', 'starwars', 'whatever', 'hello123', 'freedom', 'shadow', 'michael', 'jennifer',
  'welkom', 'welkom01', 'welkom123', 'wachtwoord', 'geheim',
]);

/**
 * A rough entropy estimate, in bits. Length times the size of the character
 * pool, except that characters which merely repeat or continue a run
 * ("aaaa", "1234", "abcd") add nothing — those are the first shapes a cracker
 * tries.
 */
export function passwordEntropyBits(password: string): number {
  if (!password) return 0;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 0;

  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;

  let effectiveLength = 0;
  for (let i = 0; i < password.length; i++) {
    const step = i === 0 ? null : password.charCodeAt(i) - password.charCodeAt(i - 1);
    if (step === null || Math.abs(step) > 1) effectiveLength += 1;
  }

  return effectiveLength * Math.log2(pool);
}

export function passwordStrength(password: string): PasswordStrength {
  const bits = passwordEntropyBits(password);
  if (bits < 45) return 'weak';
  if (bits < 75) return 'fair';
  return 'strong';
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface GeneratePasswordOptions {
  length?: number;
  uppercase?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

/** Uniform integer in [0, max) for max ≤ 256 — rejection sampling, so no modulo bias. */
function randomInt(max: number): number {
  const limit = 256 - (256 % max);
  const bytes = new Uint8Array(1);
  let value: number;
  do {
    crypto.getRandomValues(bytes);
    value = bytes[0] ?? 0;
  } while (value >= limit);
  return value % max;
}

function pick(alphabet: string): string {
  return alphabet.charAt(randomInt(alphabet.length));
}

/**
 * A random password from `crypto.getRandomValues`. Look-alike characters
 * (l/1/I, O/0) are left out so it can be read aloud or typed from a screen,
 * and every enabled character class is guaranteed to appear at least once.
 */
export function generatePassword(options: GeneratePasswordOptions = {}): string {
  const length = Math.min(Math.max(options.length ?? 20, 8), 128);
  const classes = [LOWER];
  if (options.uppercase !== false) classes.push(UPPER);
  if (options.digits !== false) classes.push(DIGITS);
  if (options.symbols !== false) classes.push(SYMBOLS);

  const all = classes.join('');
  const chars = classes.map((alphabet) => pick(alphabet));
  while (chars.length < length) chars.push(pick(all));

  // Fisher–Yates, so the guaranteed characters are not always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const swapped = chars[i] ?? '';
    chars[i] = chars[j] ?? '';
    chars[j] = swapped;
  }
  return chars.join('');
}
