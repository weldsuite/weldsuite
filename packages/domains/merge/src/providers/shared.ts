/**
 * What GitLab, Bitbucket and Azure DevOps mappers share: the normalized
 * webhook event shapes (merge-api's `services/providers/types.ts` declares the
 * same shapes; TypeScript checks they stay assignable), date parsing and the
 * signature primitives. Pure: no I/O beyond Web Crypto, no Hono, no database.
 */

import type { MergeChecksStatus, MergeReviewDecision } from '@weldsuite/db/schema';
import type { MirrorFields } from '../github';

export type { MirrorFields };

export interface NormalizedIssue {
  externalId: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  stateReason: 'completed' | 'not_planned' | null;
  labels: string[];
  assigneeLogin: string | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  updatedAt: Date;
}

export interface NormalizedIssueComment {
  externalId: string;
  issueNumber: number;
  body: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NormalizedWebhookEvent =
  | { kind: 'pull_request'; repositoryExternalId: string; action: string; pullRequest: MirrorFields }
  | { kind: 'review'; repositoryExternalId: string; number: number; decision: MergeReviewDecision | null }
  | {
      kind: 'checks';
      repositoryExternalId: string;
      headSha: string;
      status: MergeChecksStatus | null;
      numbers: number[];
    }
  | { kind: 'issue'; repositoryExternalId: string; action: string; issue: NormalizedIssue }
  | {
      kind: 'issue_comment';
      repositoryExternalId: string;
      action: 'created' | 'edited' | 'deleted';
      comment: NormalizedIssueComment;
    }
  | { kind: 'repository_removed'; repositoryExternalId: string };

export type Json = Record<string, unknown>;

/** `value` as a plain object, else null. */
export const obj = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

export const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A provider id (number or string) as a string; null for anything else. */
export function idString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return str(value);
}

const GITLAB_DATE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?: (UTC|[+-]\d{4}))?$/;

/**
 * An ISO 8601 date, or GitLab's webhook format (`2026-11-05 10:00:00 UTC`,
 * `2026-11-05 10:00:00 +0100`). An unreadable value is the epoch, so a
 * malformed row never wins a staleness comparison.
 */
export function parseProviderDate(value: unknown): Date {
  const text = str(value);
  if (!text) return new Date(0);
  const match = GITLAB_DATE.exec(text);
  let iso = text;
  if (match) {
    const zone = match[3];
    let offset = 'Z';
    if (zone && zone !== 'UTC') offset = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    iso = `${match[1]}T${match[2]}${offset}`;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export const nullableDate = (value: unknown): Date | null => (str(value) ? parseProviderDate(value) : null);

/** Removes trailing slashes (a loop, not a regular expression: no backtracking). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end--;
  return value.slice(0, end);
}

/** Lower-cases a provider login; logins are stored lower-case. */
export const lowerLogin = (value: unknown): string | null => str(value)?.toLowerCase() ?? null;

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Constant-time string comparison (the length is not secret; the content is). */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** HMAC-SHA-256 of `body` under `secret`, lower-case hex. */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Header lookup by lower-case name. */
export const header = (headers: Record<string, string>, name: string): string | null => {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return null;
};
