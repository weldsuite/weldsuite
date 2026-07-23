/**
 * Attach a console-error watcher to a Page. Returns an `assertNone()` you
 * call at test end. Filters out a small list of known-benign messages
 * (third-party SDK warnings) — keep this list as small as possible.
 */

import type { Page } from '@playwright/test';

export const IGNORE_PATTERNS: RegExp[] = [
  // Vite HMR connection noise during dev mode.
  /\[vite\]/,
  // Clerk emits this when the network briefly flaps; harmless.
  /ClerkJS:.*Network/i,
  // React DevTools install hint — printed in dev builds.
  /React DevTools/i,
  /Download the React DevTools/i,
  // Browser logs 404s for missing favicons as console errors.
  /favicon/i,
  // App-shell background services that only run as separate workers
  // (presence, notifications, realtime). When those aren't reachable — local
  // dev with just app-api up, or CI without the full worker fleet — they log
  // fetch/socket failures on every authenticated route. They're shell noise,
  // not a regression in the page under test, so the smoke "route renders"
  // checks shouldn't fail on them.
  /\[Presence\]/,
  /\[UnifiedNotification\]/,
  // Realtime (Cloudflare/CF) websocket handshake failing without valid creds.
  /WebSocket connection to .*(\/ws|realtime).*failed/i,
  // Browser-level log of the same background calls being rejected.
  // Also covers 404s from api-worker settings routes (custom-fields,
  // grid-views, dns-zones, legacy commerce endpoints) that are not available
  // in the test environment where only app-api is running.
  /Failed to load resource: the server responded with a status of (401|403|404)/,
  // React 19 stricter CSR nesting validation warns about <div> inside <table>
  // context for the shadcn Table wrapper pattern; the page renders correctly.
  /In HTML.*cannot be a child of.*<table>/i,
  // Radix UI emits this on some portal unmounts; not a regression in the page.
  /flushSync was called from inside a lifecycle method/,
  // WeldChat's core messaging surface (channels, messages, members) is served
  // by app-api in the test env, but a handful of secondary calls still target
  // the obsolete api-worker `/chat/*` routes this phase (bookmarks, read
  // receipts, active-call poll, entity channels, status). Those are unreachable
  // when only app-api is up, so the legacy worker-client logs an "API request
  // failed" error for them on channel mount — shell noise, not a regression.
  /\[ERROR\] API request failed.*\/chat\//,
  // WeldChat's member-directory picker (useWorkspaceMembers) still reads the
  // legacy api-worker `/settings/members` route, unreachable in the test env.
  /\[ERROR\] API request failed.*\/settings\/members/,
  // Legacy api-worker /settings/my-role is unreachable in isolated test
  // environments; caught and logged by ResourceUsage inside UnifiedModuleSidebar.
  /Error fetching workspace role/i,
  // TanStack Router routes notFound() through React's error boundary on
  // WorkflowEditPage when the workflow id doesn't exist; page renders the
  // not-found UI correctly so this boundary log is expected, not a regression.
  /The above error occurred in the .WorkflowEditPage. component/i,
];

export function watchConsoleErrors(page: Page) {
  const errors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORE_PATTERNS.some((re) => re.test(text))) return;
    errors.push(text);
  });

  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  return {
    errors,
    assertNone: () => {
      if (errors.length > 0) {
        throw new Error(
          `Unexpected console errors:\n  - ${errors.join('\n  - ')}`,
        );
      }
    },
  };
}
