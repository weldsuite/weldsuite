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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One whitespace-separated word, with an address, link or number replaced by a token. */
function tokenizeWord(word: string): string {
  if (word.includes('://') || word.startsWith('www.')) return 'tokurl';
  const at = word.indexOf('@');
  if (at > 0 && word.indexOf('.', at) > at + 1) return 'tokemail';
  if (/^[\d.,:/-]+$/.test(word) && /\d/.test(word)) return 'toknum';
  return word.replace(/\d+/g, ' toknum ');
}

/** Lower-cased, tokenised text with merge fields replaced. Deterministic. */
export function normalizeForFingerprint(input: NormalizeInput): string {
  const subject = (input.subject ?? '').replace(/^\s*((re|fw|fwd|aw|wg|antw)\s*:\s*)+/i, '');
  let text = `${subject}\n${stripQuotedAndSignature(input.text)}`
    .toLowerCase()
    .split(/\s+/)
    .map(tokenizeWord)
    .join(' ');
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

/** Word 3-shingles; a text of fewer than three words is one shingle. */
function shinglesOf(words: string[]): string[] {
  if (words.length < 3) return words.length > 0 ? [words.join(' ')] : [];
  const shingles: string[] = [];
  for (let i = 0; i + 2 < words.length; i++) shingles.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return shingles;
}

/** Add one 32-bit hash to 32 of the SimHash weights, from `offset`. */
function addVotes(weights: number[], hash: number, offset: number): void {
  for (let bit = 0; bit < 32; bit++) {
    weights[offset + bit] = (weights[offset + bit] ?? 0) + ((hash >>> bit) & 1 ? 1 : -1);
  }
}

/** The 32 bits whose weights from `offset` are positive, as 8 hex characters. */
function bitsToHex(weights: number[], offset: number): string {
  let value = 0;
  for (let bit = 0; bit < 32; bit++) {
    if ((weights[offset + bit] ?? 0) > 0) value |= 1 << bit;
  }
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** 64-bit SimHash of word 3-shingles, as 16 lower-case hex characters. */
export function simhash64(normalized: string): string {
  const weights = new Array<number>(64).fill(0);
  for (const shingle of shinglesOf(normalized.split(' ').filter(Boolean))) {
    addVotes(weights, fnv1a32(shingle, 0x9e3779b9), 0);
    addVotes(weights, fnv1a32(shingle, 0x7f4a7c15), 32);
  }
  return bitsToHex(weights, 0) + bitsToHex(weights, 32);
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
const GENERIC_LABELS = new Set([
  'info', 'mail', 'contact', 'hello', 'sales', 'support', 'admin', 'office', 'team',
  'gmail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'live',
]);

/** Name-like parts of one address: local-part pieces and the domain's first label. */
function addressTokens(address: string): string[] {
  const [local, domain] = address.toLowerCase().split('@');
  const candidates = [...(local ?? '').split(/[._+-]/), (domain ?? '').split('.')[0] ?? ''];
  return candidates.filter((part) => part.length >= 3 && !GENERIC_LABELS.has(part));
}

export function personalTokensFor(recipients: string[], names: string[] = []): string[] {
  const nameParts = names.flatMap((name) => name.split(/\s+/)).filter((part) => part.length >= 2);
  return [...new Set([...nameParts, ...recipients.flatMap(addressTokens)])];
}
