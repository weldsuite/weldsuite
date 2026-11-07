/**
 * Shared plumbing for the review adapters (phase 4): one `fetch` per call, the
 * provider's own error message passed through as a `ProviderApiError`, and the
 * unified-diff helpers GitLab and Bitbucket need. No Hono context, no retries:
 * every outbound call is deterministic for a given input.
 */

import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import { ProviderApiError } from './types';

export const REVIEW_PAGE = 100;
export const MAX_FILES = 300;
export const MAX_COMMENTS = 300;

export interface ProviderRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
}

function messageOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return null;
}

/** The provider's own words for a failure: `message`, `error`, `error.message`, or the raw body. */
export function providerMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const nested = (body.error as { message?: unknown } | undefined)?.message;
    const found = messageOf(body.message) ?? messageOf(nested) ?? messageOf(body.error);
    if (found) return found;
  } catch {
    if (text.trim()) return text.trim().slice(0, 500);
  }
  return `Provider answered ${status}`;
}

async function send(provider: MergeProvider, req: ProviderRequest, accept: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'WeldSuite-WeldMerge', ...req.headers };
  const init: RequestInit = { method: req.method, headers };
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(req.body);
  }
  const res = await fetch(req.url, init);
  if (!res.ok) throw new ProviderApiError(provider, res.status, providerMessage(res.status, await res.text()));
  return res;
}

/** The parsed JSON of a successful answer; null for an empty one (204). */
export async function providerJson<T>(provider: MergeProvider, req: ProviderRequest): Promise<T | null> {
  const res = await send(provider, req, 'application/json');
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

export async function providerText(provider: MergeProvider, req: ProviderRequest): Promise<string> {
  return (await send(provider, req, 'text/plain')).text();
}

/** `Bearer` for OAuth tokens. */
export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/** The token an adapter acts with; a context without one is a provider-side 401. */
export function requireToken(provider: MergeProvider, token: string | undefined): string {
  if (!token) throw new ProviderApiError(provider, 401, `No ${provider} credentials are available for this call`);
  return token;
}

/** Added and removed lines of a unified diff body (file headers excluded). */
export function patchStats(patch: string | null): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of (patch ?? '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

/** A whole-pull-request unified diff split per file (the `b/` path of each `diff --git` section). */
export function splitUnifiedDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const header = section.split('\n', 1)[0] ?? '';
    const path = /\sb\/(.+)$/.exec(header)?.[1];
    const hunkStart = section.indexOf('\n@@');
    if (path) out.set(path, hunkStart === -1 ? '' : section.slice(hunkStart + 1).trimEnd());
  }
  return out;
}

/** `value` without trailing slashes (no regex: it stays linear). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** The side of a diff a comment sits on: the new side when it has a line there, else the old one; null without a line. */
export function diffSide(newLine: number | null | undefined, oldLine: number | null | undefined): 'LEFT' | 'RIGHT' | null {
  if (newLine) return 'RIGHT';
  return oldLine ? 'LEFT' : null;
}
