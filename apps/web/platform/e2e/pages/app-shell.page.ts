/**
 * Page object for the global app shell — the fixed left-side module
 * sidebar that's present on every authenticated screen. Wraps the
 * `data-testid="app-nav-<key>"` selectors so specs don't depend on URL
 * shape or icon alt text.
 */

import type { Page } from '@playwright/test';

export class AppShellPage {
  constructor(private readonly page: Page) {}

  sidebar() {
    return this.page.getByTestId('app-sidebar');
  }

  nav(key:
    | 'home'
    | 'weldcrm'
    | 'weldflow'
    | 'welddesk'
    | 'weldmail'
    | 'weldconnect'
    | 'weldhost'
    | 'weldstash'
    | 'appstore') {
    return this.page.getByTestId(`app-nav-${key}`);
  }
}
