/**
 * WeldData E2E mock layer.
 *
 * The WeldData module is backed by an external lead database (Lemlist) plus
 * tenant-DB lists/leads/enrichment. There's no test-fixtures seeder for it, and
 * the search + AI/email enrichment paths depend on third-party keys, so the
 * spec mocks every `/welddata/*` (and `/ai-models/*`) response at the network
 * layer. This makes the suite hermetic and deterministic — it exercises the
 * full UI without any provisioning.
 *
 * Everything non-welddata (app shell, workspace, settings) still hits the real
 * test app-api, matching the rest of the suite.
 */

import type { Page } from '@playwright/test';

const NOW = '2026-06-15T10:00:00.000Z';

export const PERSON_LIST = {
  id: 'wdlist_people',
  kind: 'person' as const,
  name: 'E2E People',
  color: 'bg-blue-500',
  icon: 'User',
  createdAt: NOW,
  updatedAt: NOW,
  leadCount: 1,
};

export const COMPANY_LIST = {
  id: 'wdlist_co',
  kind: 'company' as const,
  name: 'E2E Companies',
  color: 'bg-emerald-500',
  icon: 'Building2',
  createdAt: NOW,
  updatedAt: NOW,
  leadCount: 1,
};

/** A deliberately long enrichment value so the cell is clamped in the grid and
 * the detail dialog has something extra to reveal. */
export const LONG_CELL_VALUE =
  'Ada Lovelace is the Chief Technology Officer. ' +
  'She has led engineering since 2019 and previously founded two analytics startups. ' +
  'This sentence exists only to overflow the three-line clamp so the detail dialog is testable.';

const PERSON_LEAD = {
  id: 'lead_p1',
  listId: PERSON_LIST.id,
  kind: 'person' as const,
  name: 'Ada Lovelace',
  email: '',
  title: 'CTO',
  companyName: 'Analytical Co',
  domain: 'analytical.co',
  industry: 'Software',
  location: 'London',
  country: 'United Kingdom',
  companySize: '11-50',
  linkedinUrl: 'https://www.linkedin.com/in/ada',
  data: {},
  convertedStatus: 'pending' as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const COMPANY_LEAD = {
  id: 'lead_c1',
  listId: COMPANY_LIST.id,
  kind: 'company' as const,
  name: 'Globex',
  email: '',
  title: null,
  companyName: 'Globex',
  domain: 'globex.com',
  industry: 'Manufacturing',
  location: 'New York',
  country: 'United States',
  companySize: '201-500',
  linkedinUrl: 'https://www.linkedin.com/company/globex',
  data: {},
  convertedStatus: 'pending' as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const PERSON_COLUMN = {
  id: 'col_ceo',
  listId: PERSON_LIST.id,
  name: 'CEO',
  type: 'ai' as const,
  config: { type: 'ai', prompt: 'Who is the CEO of {{companyName}}?' },
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const PERSON_CELL = {
  id: 'cell_1',
  columnId: PERSON_COLUMN.id,
  leadId: PERSON_LEAD.id,
  status: 'done' as const,
  value: LONG_CELL_VALUE,
  data: { modelId: 'claude-opus-4-8' },
  error: null,
  creditsUsed: 3,
  ranAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

export const PEOPLE_SEARCH = {
  rows: [
    {
      id: 's_p1',
      kind: 'person',
      name: 'Grace Hopper',
      email: null,
      title: 'VP Engineering',
      companyName: 'Compiler Inc',
      domain: 'compiler.io',
      industry: 'Software',
      location: 'Arlington',
      country: 'United States',
      companySize: '51-200',
      linkedinUrl: 'https://www.linkedin.com/in/grace',
      avatarUrl: null,
      raw: {},
    },
  ],
  page: 1,
  size: 25,
  total: 1,
  hasMore: false,
};

export const COMPANY_SEARCH = {
  rows: [
    {
      id: 's_c1',
      kind: 'company',
      name: 'Stripe',
      email: null,
      title: null,
      companyName: 'Stripe',
      domain: 'stripe.com',
      industry: 'Fintech',
      location: 'San Francisco',
      country: 'United States',
      companySize: '1001-5000',
      linkedinUrl: 'https://www.linkedin.com/company/stripe',
      avatarUrl: null,
      raw: {},
    },
  ],
  page: 1,
  size: 25,
  total: 1,
  hasMore: false,
};

export interface WelddataMockState {
  /** Records the last add-to-list payload for assertions. */
  lastAddLeads?: { listId: string; body: unknown };
  /** Records the last create-list payload. */
  lastCreateList?: unknown;
  /** Counts run-cell / run-column requests. */
  runCellCount: number;
  runColumnCount: number;
}

/**
 * Install all WeldData route mocks on a page. Returns a mutable state object the
 * test can assert against (captured payloads, run counts).
 */
export async function mockWelddata(page: Page): Promise<WelddataMockState> {
  const state: WelddataMockState = { runCellCount: 0, runColumnCount: 0 };

  const lists = [PERSON_LIST, COMPANY_LIST];
  const leadsByList: Record<string, unknown[]> = {
    [PERSON_LIST.id]: [PERSON_LEAD],
    [COMPANY_LIST.id]: [COMPANY_LEAD],
  };
  const columnsByList: Record<string, unknown[]> = {
    [PERSON_LIST.id]: [PERSON_COLUMN],
    [COMPANY_LIST.id]: [],
  };
  const cellsByList: Record<string, unknown[]> = {
    [PERSON_LIST.id]: [PERSON_CELL],
    [COMPANY_LIST.id]: [],
  };

  // Make WeldData (and the standard modules) appear installed for the test
  // workspace so the `useAppAccess('welddata')` layout guard lets the module
  // render instead of showing "app not installed".
  await page.route('**/dashboard/installed-apps**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          'welddata', 'weldcrm', 'welddesk', 'weldmail', 'weldflow',
          'weldconnect', 'weldhost', 'weldstash', 'weldbooks', 'weldchat', 'weldmeet',
          'weldcalendar', 'welddrive', 'social', 'parcel',
        ],
      }),
    }),
  );

  await page.route('**/ai-models/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            modelId: 'claude-opus-4-8',
            provider: 'anthropic',
            displayName: 'Claude Opus 4.8',
            tier: 'premium',
            inputPriceCents: 0,
            outputPriceCents: 0,
            creditsPerKToken: 1,
            sortOrder: 0,
          },
        ],
      }),
    }),
  );

  await page.route('**/welddata/**', async (route) => {
    const req = route.request();
    // Only intercept API calls — never the SPA's own page navigations
    // (`/welddata`, `/welddata/lists/:id` are document requests that must load
    // the real app, not our JSON).
    const rt = req.resourceType();
    if (rt !== 'fetch' && rt !== 'xhr') return route.continue();
    const method = req.method();
    // Strip an optional `/api` prefix so matching is host/prefix agnostic.
    const p = new URL(req.url()).pathname.replace(/^\/api/, '');
    const json = (status: number, data: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const listResp = (data: unknown[]) =>
      json(200, { data, pagination: { totalCount: data.length, hasMore: false, cursor: null } });

    // --- search ---
    if (method === 'POST' && p === '/welddata/search/people') return json(200, { data: PEOPLE_SEARCH });
    if (method === 'POST' && p === '/welddata/search/companies') return json(200, { data: COMPANY_SEARCH });

    // --- lists collection ---
    if (p === '/welddata/lists' && method === 'GET') return listResp(lists);
    if (p === '/welddata/lists' && method === 'POST') {
      const body = req.postDataJSON();
      state.lastCreateList = body;
      const created = {
        ...PERSON_LIST,
        id: 'wdlist_new',
        name: body.name,
        kind: body.kind ?? 'person',
        color: body.color ?? 'bg-blue-500',
        icon: body.icon ?? 'Database',
        leadCount: 0,
      };
      lists.push(created);
      return json(201, { data: created });
    }

    // --- single list ---
    let m = p.match(/^\/welddata\/lists\/([^/]+)$/);
    if (m && method === 'GET') {
      const list = lists.find((l) => l.id === m![1]) ?? lists[0];
      return json(200, { data: list });
    }
    if (m && (method === 'PATCH' || method === 'DELETE')) {
      return method === 'DELETE' ? route.fulfill({ status: 204, body: '' }) : json(200, { data: lists[0] });
    }

    // --- leads ---
    m = p.match(/^\/welddata\/lists\/([^/]+)\/leads$/);
    if (m && method === 'GET') return listResp(leadsByList[m[1]] ?? []);
    if (m && method === 'POST') {
      state.lastAddLeads = { listId: m[1], body: req.postDataJSON() };
      return json(201, { data: { added: 1, skipped: 0 } });
    }

    // --- columns ---
    m = p.match(/^\/welddata\/lists\/([^/]+)\/columns$/);
    if (m && method === 'GET') return json(200, { data: columnsByList[m[1]] ?? [] });
    if (m && method === 'POST') {
      const body = req.postDataJSON();
      return json(201, {
        data: { ...PERSON_COLUMN, id: 'col_new', listId: m[1], name: body.name, config: body.config },
      });
    }

    // --- cells ---
    m = p.match(/^\/welddata\/lists\/([^/]+)\/cells$/);
    if (m && method === 'GET') return json(200, { data: cellsByList[m[1]] ?? [] });

    // --- runs / convert / delete ---
    if (method === 'POST' && /\/columns\/[^/]+\/run$/.test(p)) {
      state.runColumnCount++;
      return json(200, { data: { queued: 1 } });
    }
    if (method === 'POST' && p === '/welddata/cells/run') {
      state.runCellCount++;
      return json(200, { data: { queued: 1 } });
    }
    if (method === 'POST' && /\/leads\/[^/]+\/convert$/.test(p)) {
      return json(200, { data: { leadId: 'lead_p1', personId: 'person_x' } });
    }
    if (method === 'DELETE' && /\/leads\/[^/]+$/.test(p)) {
      return route.fulfill({ status: 204, body: '' });
    }

    // Fallback — should not be hit; keep it benign so it never errors the UI.
    return json(200, { data: [] });
  });

  return state;
}
