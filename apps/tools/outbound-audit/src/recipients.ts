/**
 * Recipient parsing, first-contact checks and text scrubbing. Pure.
 */

import { isSharedWeldMailDomain } from '@weldsuite/app-api-client/schemas/outbound-mail';
import type { AddressEntry, CorrespondentContext, SendKind } from './types';

const FORBIDDEN_IN_ADDRESS = /[\s<>"]/;
const ANGLED = /<([^<>]+)>\s*$/;

/** `local@domain.tld` with one `@`, a dot inside the domain and no spaces, quotes or brackets. */
export function isEmailAddress(value: string): boolean {
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || FORBIDDEN_IN_ADDRESS.test(value)) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1 && !domain.startsWith('.');
}

function normaliseAddress(raw: string): string | null {
  const angled = ANGLED.exec(raw);
  const email = (angled ? angled[1] : raw).trim().toLowerCase();
  return isEmailAddress(email) ? email : null;
}

function entryFrom(item: unknown): AddressEntry | null {
  if (typeof item === 'string') {
    const email = normaliseAddress(item);
    return email ? { email, name: null } : null;
  }
  if (item && typeof item === 'object' && 'email' in item) {
    const { email: rawEmail, name } = item as { email?: unknown; name?: unknown };
    if (typeof rawEmail !== 'string') return null;
    const email = normaliseAddress(rawEmail);
    if (!email) return null;
    return { email, name: typeof name === 'string' && name.trim() ? name.trim() : null };
  }
  return null;
}

/**
 * Addresses from a `to` / `cc` / `bcc` JSONB value: an array of
 * `{ email, name }` (the schema), tolerating bare strings, a single object or a
 * comma-separated string from older rows. Lower-cased and de-duplicated.
 */
export function parseAddressList(value: unknown): AddressEntry[] {
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(/[,;]/);
  else if (value && typeof value === 'object') items = [value];
  else items = [];

  const seen = new Map<string, AddressEntry>();
  for (const item of items) {
    const entry = entryFrom(item);
    if (entry && !seen.has(entry.email)) seen.set(entry.email, entry);
  }
  return [...seen.values()];
}

/** to + cc + bcc of one message, de-duplicated across the three fields. */
export function messageRecipients(to: unknown, cc: unknown, bcc: unknown): { all: AddressEntry[]; bcc: number } {
  const seen = new Map<string, AddressEntry>();
  for (const entry of [...parseAddressList(to), ...parseAddressList(cc)]) {
    if (!seen.has(entry.email)) seen.set(entry.email, entry);
  }
  let bccCount = 0;
  for (const entry of parseAddressList(bcc)) {
    if (seen.has(entry.email)) continue;
    seen.set(entry.email, entry);
    bccCount++;
  }
  return { all: [...seen.values()], bcc: bccCount };
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

export function isSharedDomainAddress(email: string): boolean {
  return isSharedWeldMailDomain(domainOf(email));
}

/**
 * Whether a recipient was a first contact when the message went out: not one
 * of the workspace's own addresses or custom domains, and no mail received from
 * it before `sentAt`. Someone who answered a cold mail later still counts as a
 * first contact for that mail.
 */
export function isFirstContact(email: string, sentAt: Date, ctx: CorrespondentContext): boolean {
  if (ctx.ownAddresses.has(email)) return false;
  if (ctx.ownDomains.has(domainOf(email))) return false;
  const firstInbound = ctx.firstInbound.get(email);
  return !firstInbound || firstInbound.getTime() > sentAt.getTime();
}

export function classifyKind(row: { inReplyTo: string | null; isReply: boolean | null; isForwarded: boolean | null }): SendKind {
  if ((row.inReplyTo && row.inReplyTo.trim()) || row.isReply) return 'reply';
  if (row.isForwarded) return 'forward';
  return 'new_thread';
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function utcHour(date: Date): string {
  return date.toISOString().slice(0, 13);
}

const SCRUB_URL = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
/** Seven or more digits, each optionally after one separator: phone and account numbers. */
const SCRUB_LONG_NUMBER = /\+?\d(?:[\s().-]?\d){6,}/g;

/** Every whitespace-separated word with an `@` in it: broader than an address on purpose, and linear. */
function scrubAddresses(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (part.includes('@') ? '[email]' : part))
    .join('');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text safe to put in the report: addresses, links, phone-like numbers and the
 * recipients' names / company labels replaced, whitespace collapsed, cut to
 * `max` characters.
 */
export function scrubText(text: string, personalTokens: string[], max: number): string {
  let out = scrubAddresses(text).replace(SCRUB_URL, '[url]').replace(SCRUB_LONG_NUMBER, '[number]');
  for (const raw of personalTokens) {
    const token = raw.trim();
    if (token.length < 2) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'gi'), '[name]');
  }
  return truncate(out.replace(/\s+/g, ' ').trim(), max);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
