/**
 * Template fingerprints for outbound mail.
 *
 * One template going to many recipients who never wrote in is the core
 * cold-email pattern, whichever path sent it. Merge fields ("Hi Anna", "at
 * Acme") make every copy a little different, so the body is normalised first
 * (quoted history and signature cut, addresses, links, numbers and the
 * recipient's own name and company replaced by tokens) and then hashed with a
 * 64-bit SimHash over word 3-shingles. Two copies of one template land within
 * a Hamming distance of {@link FINGERPRINT_MAX_DISTANCE}; unrelated mails don't.
 *
 * Pure and synchronous: it runs in the send path for every new conversation.
 */

import { FINGERPRINT_MAX_DISTANCE } from '@weldsuite/app-api-client/schemas/outbound-mail';

/** Templates shorter than this many words are too generic to fingerprint ("Thanks!"). */
export const MIN_FINGERPRINT_WORDS = 12;

/** The normalised text kept for an AI review sample. */
export const MAX_SAMPLE_CHARS = 4_000;

const QUOTE_MARKERS = [
  /^-{2,}\s*(original message|forwarded message|oorspronkelijk bericht|doorgestuurd bericht)\s*-{2,}/i,
  /^on .{3,200} wrote:\s*$/i,
  /^op .{3,200} schreef .{0,200}:\s*$/i,
  /^(from|van):\s.+$/i,
];

/** Cut quoted history (`>` lines and "On … wrote:" blocks) and the `-- ` signature. */
export function stripQuotedAndSignature(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '--' || line === '-- ') break;
    if (QUOTE_MARKERS.some((re) => re.test(trimmed))) break;
    if (trimmed.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n');
}

export interface NormalizeInput {
  subject?: string | null;
  text: string;
  /** Recipient names and companies to replace with a token (merge fields). */
  personalTokens?: string[];
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const NUMBER_RE = /\d+(?:[.,:/-]\d+)*/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lower-cased, tokenised text with merge fields replaced. Deterministic. */
export function normalizeForFingerprint(input: NormalizeInput): string {
  const subject = (input.subject ?? '').replace(/^\s*((re|fw|fwd|aw|wg|antw)\s*:\s*)+/i, '');
  let text = `${subject}\n${stripQuotedAndSignature(input.text)}`.toLowerCase();
  text = text.replace(EMAIL_RE, ' tokemail ').replace(URL_RE, ' tokurl ').replace(NUMBER_RE, ' toknum ');
  for (const raw of input.personalTokens ?? []) {
    const token = raw.trim().toLowerCase();
    if (token.length < 2) continue;
    text = text.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g'), ' tokname ');
  }
  return text
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SAMPLE_CHARS);
}

/** FNV-1a over UTF-16 code units, 32 bits, with a seed so two runs give 64 bits. */
function fnv1a32(value: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Final avalanche so short shingles spread over all bits.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** 64-bit SimHash of word 3-shingles, as 16 lower-case hex characters. */
export function simhash64(normalized: string): string {
  const words = normalized.split(' ').filter(Boolean);
  const shingles: string[] = [];
  if (words.length < 3) {
    if (words.length > 0) shingles.push(words.join(' '));
  } else {
    for (let i = 0; i + 2 < words.length; i++) shingles.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  const weights = new Array<number>(64).fill(0);
  for (const shingle of shingles) {
    const hi = fnv1a32(shingle, 0x9e3779b9);
    const lo = fnv1a32(shingle, 0x7f4a7c15);
    for (let bit = 0; bit < 32; bit++) {
      weights[bit] = (weights[bit] ?? 0) + ((hi >>> bit) & 1 ? 1 : -1);
      weights[bit + 32] = (weights[bit + 32] ?? 0) + ((lo >>> bit) & 1 ? 1 : -1);
    }
  }
  let hi = 0;
  let lo = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (weights[bit]! > 0) hi |= 1 << bit;
    if (weights[bit + 32]! > 0) lo |= 1 << bit;
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

/** Bits that differ between two fingerprints (64 when either is malformed). */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) return 64;
  const ahi = Number.parseInt(a.slice(0, 8), 16);
  const alo = Number.parseInt(a.slice(8), 16);
  const bhi = Number.parseInt(b.slice(0, 8), 16);
  const blo = Number.parseInt(b.slice(8), 16);
  if ([ahi, alo, bhi, blo].some(Number.isNaN)) return 64;
  return popcount32((ahi ^ bhi) >>> 0) + popcount32((alo ^ blo) >>> 0);
}

export function isSameTemplate(a: string, b: string): boolean {
  return hammingDistance(a, b) <= FINGERPRINT_MAX_DISTANCE;
}

export interface TemplateFingerprint {
  fingerprint: string;
  /** Normalised text, at most {@link MAX_SAMPLE_CHARS}; the AI review sample. */
  normalized: string;
  words: number;
  /** Too short to say anything about a template; not tracked. */
  tooShort: boolean;
}

/**
 * Fingerprint one outgoing message. `personalTokens` should hold the
 * recipients' names and the local parts / company labels of their addresses,
 * so "Hi Anna at Acme" and "Hi Bram at Bolt" hash alike.
 */
export function fingerprintTemplate(input: NormalizeInput): TemplateFingerprint {
  const normalized = normalizeForFingerprint(input);
  const words = normalized ? normalized.split(' ').length : 0;
  return {
    fingerprint: simhash64(normalized),
    normalized,
    words,
    tooShort: words < MIN_FINGERPRINT_WORDS,
  };
}

/**
 * Merge-field candidates for a recipient list: the local part of each address
 * split on dots ("anna.de.vries" → anna, vries), and the company label of the
 * domain ("acme" from anna@acme.co.uk). Generic labels are skipped.
 */
export function personalTokensFor(recipients: string[], names: string[] = []): string[] {
  const generic = new Set(['info', 'mail', 'contact', 'hello', 'sales', 'support', 'admin', 'office', 'team', 'gmail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'live']);
  const tokens = new Set<string>();
  for (const name of names) for (const part of name.split(/\s+/)) if (part.length >= 2) tokens.add(part);
  for (const address of recipients) {
    const [local, domain] = address.toLowerCase().split('@');
    for (const part of (local ?? '').split(/[._+-]/)) if (part.length >= 3 && !generic.has(part)) tokens.add(part);
    const label = (domain ?? '').split('.')[0];
    if (label && label.length >= 3 && !generic.has(label)) tokens.add(label);
  }
  return [...tokens];
}
