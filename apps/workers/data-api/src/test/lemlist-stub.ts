/**
 * A stand-in for Lemlist's lead database (`https://api.lemlist.com/api`): the
 * filter catalog and the people and company searches. It answers by method,
 * URL and body only, never by call order, so the same stub answers both
 * backends in conformance mode (the Rust server's calls reach it through the
 * harness's outbound bridge).
 *
 * A search for a filter value of `boom`, `unauthorized` or `busy` fails with a
 * 500, a 401 or a 429.
 */

import { vi } from 'vitest';

export const LEMLIST = 'https://api.lemlist.com/api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PEOPLE = [
  {
    _id: 'lp_ada',
    full_name: 'Ada Lovelace',
    current_exp_company_name: 'Analytical Engines',
    experiences: [
      { company_name: 'Old Co', title: 'Engineer' },
      { company_name: 'Analytical Engines', title_normalized: 'CTO', company_domain: 'engines.test', company_industry: 'Software', company_size: '11-50', company_logo_url: 'https://cdn.test/engines.png' },
    ],
    location: 'London',
    country: 'UK',
    lead_linkedin_url: 'https://linkedin.test/in/ada',
  },
  { lead_id: 'lp_grace', firstName: 'Grace', lastName: 'Hopper', experiences: [{ company_name: 'Navy', title: 'Rear Admiral', company_employee_count: 5000 }], state: 'Virginia', picture: 'https://cdn.test/grace.jpg' },
  { id: 4711, canonical_shorthand_name: 'Anon', email: '  anon@example.test ' },
];

const COMPANIES = [
  { _id: 'lc_acme', company_name: 'Acme', company_domain: 'acme.test', company_industry: 'Anvils', company_location: 'Desert', company_headquarters_country: 'US', company_employee_count: 120, company_linkedin_url: 'https://linkedin.test/company/acme', company_logo_url: 'https://cdn.test/acme.png' },
  { company_id: 'lc_globex', name: 'Globex', company_website_url: 'globex.test', company_subindustry: 'Energy' },
];

const FILTERS = {
  filters: [
    { filterId: 'jobTitle', label: 'Job title', type: 'text', mode: ['leads'] },
    { id: 'country', name: 'Country', type: 'Select', options: ['NL', { value: 'BE', label: 'Belgium' }] },
    { key: 'headcount', title: 'Headcount', type: 'range', description: 'Employees', mode: ['companies'] },
    { filterId: 'hasEmail', type: 'boolean', hint: 'Only with email', mode: ['leads', 'companies'] },
    { filterId: 'tech', values: [{ id: 'react', name: 'React' }] },
  ],
};

type Filter = { filterId: string; in: unknown[] };

function search(body: { filters?: Filter[]; page?: number; size?: number }, rows: unknown[], key: string): Response {
  const values = (body.filters ?? []).flatMap((f) => f.in.map(String));
  if (values.includes('boom')) return new Response('upstream exploded', { status: 500 });
  if (values.includes('unauthorized')) return json({ error: 'bad key' }, 401);
  if (values.includes('busy')) return json({ error: 'slow down' }, 429);
  if (values.includes('empty')) return json({ [key]: [] });
  return key === 'hits' ? json({ hits: rows, total: 42 }) : json({ results: rows });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** The fetch stub; install it with `vi.stubGlobal('fetch', stub)`. */
export function createLemlistFetchStub() {
  const realFetch = globalThis.fetch;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (!url.startsWith(`${LEMLIST}/`)) return realFetch(input, init);
    const path = url.slice(LEMLIST.length);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Parameters<typeof search>[0]) : {};
    if (path === '/database/filters') return json(FILTERS);
    if (path === '/database/people') return search(body, PEOPLE, 'hits');
    if (path === '/database/companies') return search(body, COMPANIES, 'results');
    return json({ error: 'not found' }, 404);
  });
}

/** How many Lemlist calls a stub saw since `from` (each backend calls it once per uncached request). */
export function lemlistCallsSince(stub: ReturnType<typeof createLemlistFetchStub>, from: number): number {
  return stub.mock.calls.slice(from).filter(([input]) => urlOf(input).startsWith(LEMLIST)).length;
}
