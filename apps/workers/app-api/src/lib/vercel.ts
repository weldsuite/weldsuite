/**
 * Vercel project domains API.
 *
 * The public help center (apps/web/helpcenter) is a Next.js app deployed on Vercel.
 * For Vercel to serve a custom hostname (and issue its TLS cert), the hostname
 * must be registered on the project — a DNS CNAME alone is not enough. These
 * helpers add/remove a domain on the helpcenter Vercel project.
 *
 * Requires env: VERCEL_API_TOKEN, VERCEL_HELPCENTER_PROJECT_ID, and optionally
 * VERCEL_TEAM_ID (when the project lives under a team).
 */

import type { Env } from '../types';

/** Where customer CNAMEs must point for Vercel to route + certify the hostname. */
export const VERCEL_CNAME_TARGET = 'cname.vercel-dns.com';

const API_BASE = 'https://api.vercel.com';

export class VercelError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'VercelError';
  }
}

export function isVercelConfigured(env: Env): boolean {
  return !!env.VERCEL_API_TOKEN && !!env.VERCEL_HELPCENTER_PROJECT_ID;
}

function teamQuery(env: Env): string {
  return env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}` : '';
}

interface VercelDomainResult {
  name: string;
  verified: boolean;
  verification?: Array<{ type: string; domain: string; value: string; reason: string }>;
}

/**
 * Register a hostname on the helpcenter Vercel project. Idempotent: a domain
 * that already exists on the project resolves successfully instead of throwing.
 */
export async function addHelpcenterDomain(env: Env, domain: string): Promise<VercelDomainResult> {
  const res = await fetch(
    `${API_BASE}/v10/projects/${env.VERCEL_HELPCENTER_PROJECT_ID}/domains${teamQuery(env)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.VERCEL_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: domain }),
    },
  );
  const body = (await res.json().catch(() => ({}))) as VercelDomainResult & { error?: { code?: string; message?: string } };
  if (!res.ok) {
    // Already attached to this project → treat as success.
    if (res.status === 409 || body.error?.code === 'domain_already_in_use') {
      return { name: domain, verified: true };
    }
    throw new VercelError(body.error?.message ?? `Vercel add-domain failed (${res.status})`, res.status);
  }
  return body;
}

/** Remove a hostname from the helpcenter Vercel project. Missing domains are a no-op. */
export async function removeHelpcenterDomain(env: Env, domain: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/v9/projects/${env.VERCEL_HELPCENTER_PROJECT_ID}/domains/${encodeURIComponent(domain)}${teamQuery(env)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${env.VERCEL_API_TOKEN}` } },
  );
  if (!res.ok && res.status !== 404) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new VercelError(body.error?.message ?? `Vercel remove-domain failed (${res.status})`, res.status);
  }
}
