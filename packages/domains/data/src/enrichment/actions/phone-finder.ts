/**
 * Phone-finder enrichment action — resolves a publicly-listed business phone
 * number for a lead.
 *
 * `source: 'website'` reads the company's OWN website (from its domain) and
 * extracts a number the business itself published there. This is deliberate:
 *   · ToS-clean — we read the company's own site, not third-party data we're
 *     not licensed to store (e.g. Google Maps/Places content cannot be cached).
 *   · Free — no provider key, no Anthropic credits.
 *   · No hallucination — extraction is deterministic. We return a real number
 *     the page actually contains, or an empty value. Never a guess.
 *
 * Extraction prefers `tel:` links (the site author explicitly marked these as a
 * phone), falling back to a conservative text scan (international-prefixed or
 * parenthesized-area-code forms only) to keep false positives near zero.
 *
 * Like email-finder this is NOT an Anthropic call, so it runs entirely in
 * app-api and `fetch`es the pages directly. Adding a paid source later
 * (findymail / prospeo / google_places) is a new branch here + a `source` enum
 * value — the column/cell/run machinery never changes.
 */

import type { ActionContext, ActionResult, EnrichmentAction } from './types';

interface PhoneFinderConfig {
  source?: 'website';
  /** If the website yields nothing, fall back to a grounded web search. */
  webSearchFallback?: boolean;
}

/** Pages we probe, in order. Homepage first, then the usual contact pages. */
const CANDIDATE_PATHS = ['', 'contact', 'contact-us'];

const FETCH_TIMEOUT_MS = 4000;
/** Hard ceiling on the whole website pass — keeps a slow site from running the
 * lead long enough for the workflow isolate to be evicted (which strands the
 * cell on `running`). After this we give up and let the fallback (or a blank)
 * take over. */
const SCRAPE_DEADLINE_MS = 10_000;
/** Cap the HTML we scan so a huge page can't blow the step's memory/time. */
const MAX_HTML_BYTES = 600_000;

const TEL_HREF_RE = /href\s*=\s*["']tel:([^"']+)["']/gi;
/** Conservative text fallbacks — strong phone signals, rarely false positives. */
const PHONE_TEXT_RES = [
  /(?:\+|00)\d[\d\s().\-–]{6,16}\d/g, // international: +31 20 1234567 / 0044 20 ...
  /\(\d{2,5}\)[\s.\-]?\d[\d\s.\-]{5,14}\d/g, // (020) 7946 0000 / (212) 555-0147
];

function cleanDomain(domain: string | null | undefined): string {
  return (domain ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase();
}

/** Count digits — a valid phone has 7–15 (E.164 caps at 15). */
function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

/** Normalize a raw match into a tidy display string. */
function normalizePhone(raw: string): string {
  return raw
    .replace(/[^\d+()\-.\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlausiblePhone(s: string): boolean {
  const d = digitCount(s);
  return d >= 7 && d <= 15;
}

/** Pull the best phone candidate out of one page's HTML, or null. */
function extractPhone(html: string): string | null {
  // 1. tel: links — unambiguous, the author tagged it as a phone.
  for (const m of html.matchAll(TEL_HREF_RE)) {
    const candidate = normalizePhone(decodeURIComponent(m[1] ?? ''));
    if (isPlausiblePhone(candidate)) return candidate;
  }
  // 2. Conservative text scan on the de-tagged page.
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const re of PHONE_TEXT_RES) {
    for (const m of text.matchAll(re)) {
      const candidate = normalizePhone(m[0]);
      if (isPlausiblePhone(candidate)) return candidate;
    }
  }
  return null;
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      headers: {
        // Some sites 403 a blank UA; present as a normal browser.
        'User-Agent':
          'Mozilla/5.0 (compatible; WeldSuiteBot/1.0; +https://weldsuite.org/bot)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('html') && !ct.includes('text')) return null;
    const body = await resp.text();
    return body.length > MAX_HTML_BYTES ? body.slice(0, MAX_HTML_BYTES) : body;
  } catch {
    // Timeout, DNS failure, TLS error, etc. — treat as "no number here".
    return null;
  }
}

async function findFromWebsite(domain: string): Promise<ActionResult> {
  const deadline = Date.now() + SCRAPE_DEADLINE_MS;
  for (const path of CANDIDATE_PATHS) {
    if (Date.now() >= deadline) break;
    const url = `https://${domain}/${path}`;
    const html = await fetchPage(url);
    if (!html) continue;
    const phone = extractPhone(html);
    if (phone) {
      return { value: phone, data: { source: 'website', found: true, url } };
    }
  }
  return { value: '', data: { source: 'website', found: false } };
}

/**
 * Fallback when the website yields nothing — STUBBED.
 *
 * AI has been physically removed from WeldSuite. This used to ask
 * agent-worker to run a grounded web search over the AGENT_WORKER service
 * binding; that binding no longer exists, so the fallback now always
 * returns "not found" after logging a warning, same shape as any other
 * exhausted phone-finder attempt.
 */
async function findViaWebSearch(
  _ctx: ActionContext,
  company: string,
  _domain: string,
): Promise<ActionResult> {
  console.warn(
    `[ai] AI is currently unavailable — skipping phone-finder web-search fallback for "${company}"`,
  );
  return { value: '', data: { source: 'web', found: false, verified: false, unavailable: true } };
}

export const phoneFinderAction: EnrichmentAction = {
  type: 'phone_finder',
  async run(ctx: ActionContext): Promise<ActionResult> {
    const cfg = (ctx.column.config as PhoneFinderConfig | null) ?? {};
    const domain = cleanDomain(ctx.lead.domain);
    const company = ctx.lead.companyName?.trim() || domain;

    // 1. Primary source: the company's own website (free, precise). Needs a domain.
    if (domain) {
      const fromSite = await findFromWebsite(domain);
      if (fromSite.value) return fromSite;
    }

    // 2. Opt-in fallback: grounded web search. Needs at least a company name or domain.
    if (cfg.webSearchFallback && company) {
      return findViaWebSearch(ctx, company, domain);
    }

    // Nothing found / no fallback. Surface a clear error only when we had no
    // input to work with at all.
    if (!domain && !company) {
      throw new Error('No company domain or name on this lead to find a phone number from');
    }
    return { value: '', data: { source: 'website', found: false } };
  },
};
