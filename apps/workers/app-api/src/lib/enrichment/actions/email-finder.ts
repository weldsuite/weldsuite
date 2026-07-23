/**
 * Email-finder enrichment action — resolves a verified work email for a lead
 * from their name + company domain via a data provider (Findymail or Prospeo).
 *
 * Unlike the AI action this is NOT an Anthropic call, so it runs entirely in
 * app-api (the workflow) and `fetch`es the provider API directly. Each provider
 * needs its own worker secret (FINDYMAIL_API_KEY / PROSPEO_API_KEY).
 *
 * Provider credits are reported on the cell (`data.provider`) but are not yet
 * metered against the workspace credit balance — that path lives in
 * agent-worker and only covers Anthropic today.
 */

import type { ActionContext, ActionResult, EnrichmentAction } from './types';

interface EmailFinderConfig {
  provider?: 'findymail' | 'prospeo';
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Pull the first email-looking string out of an arbitrary provider payload. */
function extractEmail(payload: unknown): string | null {
  if (!payload) return null;
  if (typeof payload === 'string') {
    const m = payload.match(EMAIL_RE);
    return m ? m[0] : null;
  }
  if (typeof payload === 'object') {
    // Common explicit fields first.
    const obj = payload as Record<string, unknown>;
    for (const key of ['email', 'work_email', 'professional_email']) {
      const v = obj[key];
      if (typeof v === 'string' && EMAIL_RE.test(v)) return v;
    }
    // Otherwise scan the whole structure.
    const m = JSON.stringify(payload).match(EMAIL_RE);
    return m ? m[0] : null;
  }
  return null;
}

function cleanDomain(domain: string | null | undefined): string {
  return (domain ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .trim();
}

async function findWithFindymail(
  ctx: ActionContext,
  name: string,
  domain: string,
): Promise<ActionResult> {
  const key = ctx.env.FINDYMAIL_API_KEY;
  if (!key) throw new Error('Findymail is not configured (missing FINDYMAIL_API_KEY)');
  const resp = await fetch('https://app.findymail.com/api/search/name', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ name, domain }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Findymail HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = (await resp.json().catch(() => ({}))) as unknown;
  const email = extractEmail(json);
  return { value: email ?? '', data: { provider: 'findymail', found: !!email } };
}

async function findWithProspeo(
  ctx: ActionContext,
  name: string,
  domain: string,
): Promise<ActionResult> {
  const key = ctx.env.PROSPEO_API_KEY;
  if (!key) throw new Error('Prospeo is not configured (missing PROSPEO_API_KEY)');
  const resp = await fetch('https://api.prospeo.io/email-finder', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-KEY': key,
    },
    body: JSON.stringify({ full_name: name, company: domain }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Prospeo HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = (await resp.json().catch(() => ({}))) as unknown;
  const email = extractEmail(json);
  return { value: email ?? '', data: { provider: 'prospeo', found: !!email } };
}

export const emailFinderAction: EnrichmentAction = {
  type: 'email_finder',
  async run(ctx: ActionContext): Promise<ActionResult> {
    const cfg = (ctx.column.config as EmailFinderConfig | null) ?? {};
    const provider = cfg.provider ?? 'findymail';

    const name = ctx.lead.name?.trim();
    const domain = cleanDomain(ctx.lead.domain);
    if (!name) throw new Error('No contact name on this lead to look up');
    if (!domain) throw new Error('No company domain on this lead to find an email against');

    return provider === 'prospeo'
      ? findWithProspeo(ctx, name, domain)
      : findWithFindymail(ctx, name, domain);
  },
};
