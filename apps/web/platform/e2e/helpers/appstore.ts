/**
 * App Store E2E mock layer.
 *
 * The App Store reads `/settings/available-apps`, `/settings/app-categories`
 * and `/settings/can-manage-apps`, and mutates through
 * `POST /settings/apps/:code/install` + `DELETE /settings/apps/:code`. Those
 * routes are still served by the obsolete `api-worker`, which is NOT running in
 * the test environment (only `app-api` is up — see helpers/console-errors.ts).
 * Left unmocked, the page renders the "no access" state (because
 * can-manage-apps 404s) and shows no apps.
 *
 * So the spec mocks every App Store `/settings/*` response at the network layer.
 * This makes the suite hermetic and deterministic — it exercises the full UI
 * (category grouping, install/uninstall, detail view) without provisioning, and
 * without ever mutating the shared test workspace's real installed-apps state.
 *
 * Everything non-App-Store (app shell, workspace, other settings) still hits the
 * real test app-api / 404s harmlessly, matching the rest of the suite.
 */

import type { Page } from '@playwright/test';

const NOW = '2026-01-15T10:00:00.000Z';

/** Minimal shape the App Store UI reads — mirrors `AvailableApp` from
 * hooks/queries/use-settings-queries.ts. */
export interface MockApp {
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  provider: string;
  verified: boolean;
  isInstalled: boolean;
  overview?: string | null;
  features?: string[];
  version?: string;
  releasedAt?: string | null;
  websiteUrl?: string | null;
  documentationUrl?: string | null;
  contactUrl?: string | null;
}

/**
 * One app per consolidated category so the grouping logic in
 * app-store-client.tsx is fully exercised:
 *   - weldcrm   (Sales)        → "Customers"
 *   - weldmail  (Communication)→ "Communication"
 *   - weldflow  (Productivity) → "Work"
 *   - welddrive (Productivity) → "Storage"  (APP_CODE_OVERRIDES wins over keyword)
 *   - weldbooks (Accounting)   → "Finance"
 *
 * A mix of installed / not-installed exercises both the "Installed" badge and
 * the hover install button. weldcrm carries full resource links + overview so
 * the detail page's sidebar (Built by / Resources / Overview) is testable.
 */
export const SAMPLE_APPS: MockApp[] = [
  {
    code: 'weldcrm',
    name: 'WeldCRM',
    description: 'Manage contacts, customers, leads and your sales pipeline.',
    icon: '',
    category: 'Sales',
    provider: 'WeldSuite',
    verified: true,
    isInstalled: true,
    overview: 'WeldCRM keeps every customer relationship in one place.',
    features: ['Contacts', 'Pipelines', 'Quotes'],
    version: '2.3.0',
    releasedAt: NOW,
    websiteUrl: 'https://weldsuite.org/weldcrm',
    documentationUrl: 'https://docs.weldsuite.org/weldcrm',
    contactUrl: 'mailto:support@weldsuite.org',
  },
  {
    code: 'weldmail',
    name: 'WeldMail',
    description: 'A unified inbox for all your team email.',
    icon: '',
    category: 'Communication',
    provider: 'WeldSuite',
    verified: true,
    isInstalled: false,
    overview: 'WeldMail brings every mailbox into one shared workspace.',
    features: ['Shared inbox', 'Templates', 'Rules'],
    version: '1.8.0',
    releasedAt: NOW,
    websiteUrl: null,
    documentationUrl: null,
    contactUrl: null,
  },
  {
    code: 'weldflow',
    name: 'WeldFlow',
    description: 'Plan projects, sprints and tasks for your whole team.',
    icon: '',
    category: 'Productivity',
    provider: 'WeldSuite',
    verified: true,
    isInstalled: false,
    overview: null,
    features: [],
    version: '1.0.0',
    releasedAt: null,
    websiteUrl: null,
    documentationUrl: null,
    contactUrl: null,
  },
  {
    code: 'welddrive',
    name: 'WeldDrive',
    description: 'Store, share and organise your workspace files.',
    icon: '',
    // Stored as "Productivity" but APP_CODE_OVERRIDES forces it into "Storage".
    category: 'Productivity',
    provider: 'WeldSuite',
    verified: true,
    isInstalled: false,
    overview: null,
    features: [],
    version: '1.0.0',
    releasedAt: null,
    websiteUrl: null,
    documentationUrl: null,
    contactUrl: null,
  },
  {
    code: 'weldbooks',
    name: 'WeldBooks',
    description: 'Double-entry accounting, invoices and VAT returns.',
    icon: '',
    category: 'Accounting',
    provider: 'WeldSuite',
    verified: true,
    isInstalled: true,
    overview: 'WeldBooks is your books, balanced.',
    features: ['Invoices', 'Bills', 'VAT'],
    version: '3.1.0',
    releasedAt: NOW,
    websiteUrl: null,
    documentationUrl: null,
    contactUrl: null,
  },
];

export interface AppStoreMockOptions {
  /** Whether can-manage-apps reports the user as an owner/admin. Default true. */
  canManage?: boolean;
  /** App catalog to serve. Defaults to a deep copy of SAMPLE_APPS. */
  apps?: MockApp[];
  /** When true, install POSTs respond 500 so the error/revert path is testable. */
  failInstall?: boolean;
  /** When true, uninstall DELETEs respond 500 so the error/revert path is testable. */
  failUninstall?: boolean;
}

export interface AppStoreMockState {
  /** App catalog being served — mutated in place on successful install/uninstall. */
  apps: MockApp[];
  /** App codes that received an install POST, in order. */
  installs: string[];
  /** App codes that received an uninstall DELETE, in order. */
  uninstalls: string[];
  /** Body of the most recent install POST (carries `assignToAllMembers`). */
  lastInstallBody: Record<string, unknown> | null;
}

/**
 * Install App Store route mocks on a page. Returns a mutable state object the
 * test can assert against (which apps were installed/uninstalled, the install
 * payload). Call BEFORE `page.goto()`.
 */
export async function mockAppStore(
  page: Page,
  options: AppStoreMockOptions = {},
): Promise<AppStoreMockState> {
  const canManage = options.canManage ?? true;
  // Deep copy so install/uninstall mutations never leak across tests.
  const apps: MockApp[] = options.apps
    ? options.apps.map((a) => ({ ...a }))
    : SAMPLE_APPS.map((a) => ({ ...a }));

  const categories = Array.from(new Set(apps.map((a) => a.category)));

  const state: AppStoreMockState = {
    apps,
    installs: [],
    uninstalls: [],
    lastInstallBody: null,
  };

  await page.route('**/settings/**', async (route) => {
    const req = route.request();
    // Only intercept API calls — never document navigations.
    const rt = req.resourceType();
    if (rt !== 'fetch' && rt !== 'xhr') return route.continue();

    const method = req.method();
    // Strip an optional `/api` prefix so matching is host/prefix agnostic.
    const p = new URL(req.url()).pathname.replace(/^\/api/, '');
    const json = (status: number, data: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });

    // --- reads ---
    if (p === '/settings/available-apps' && method === 'GET') {
      return json(200, { success: true, data: state.apps });
    }
    if (p === '/settings/app-categories' && method === 'GET') {
      return json(200, { success: true, data: categories });
    }
    if (p === '/settings/can-manage-apps' && method === 'GET') {
      return json(200, { success: true, data: { canManage } });
    }

    // --- install ---
    let m = p.match(/^\/settings\/apps\/([^/]+)\/install$/);
    if (m && method === 'POST') {
      const code = m[1];
      state.installs.push(code);
      try {
        state.lastInstallBody = req.postDataJSON() as Record<string, unknown>;
      } catch {
        state.lastInstallBody = null;
      }
      if (options.failInstall) {
        return json(500, { error: 'Install failed (mock)' });
      }
      const app = state.apps.find((a) => a.code === code);
      if (app) app.isInstalled = true;
      return json(200, { success: true, data: { code, installed: true } });
    }

    // --- uninstall ---
    m = p.match(/^\/settings\/apps\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const code = m[1];
      state.uninstalls.push(code);
      if (options.failUninstall) {
        return json(500, { error: 'Uninstall failed (mock)' });
      }
      const app = state.apps.find((a) => a.code === code);
      if (app) app.isInstalled = false;
      return route.fulfill({ status: 204, body: '' });
    }

    // Every other /settings/* call (shell role, members, custom-fields, …) is
    // not ours — let it hit the network (404s in the test env are tolerated by
    // the console-error filter).
    return route.continue();
  });

  return state;
}

/** Locator for an app card on the list page (the card is an <a> to the detail). */
export function appCard(page: Page, code: string) {
  return page.locator(`a[href$="/appstore/${code}"]`);
}
