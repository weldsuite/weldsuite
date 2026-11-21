/**
 * The server-side install snippets. Code is not translated, so it lives here
 * and not in the locale files; both are built from the project's collector URL,
 * like the script snippet the API returns. Kept in line with
 * `@weldsuite/panel-sdk/server` and `POST /v1/track` (`serverEventSchema`).
 */

/** `createPanelServer` and `track`, as in the SDK's README. */
export function serverSdkSnippet(collectorUrl: string): string {
  return [
    "import { createPanelServer } from '@weldsuite/panel-sdk/server';",
    '',
    'const panel = createPanelServer({',
    '  secretKey: process.env.WELDPANEL_SECRET_KEY!,',
    `  collectorUrl: '${collectorUrl}',`,
    '});',
    '',
    "panel.track({ name: 'Subscription renewed', distinctId: user.id, userId: user.id, props: { plan: 'pro' } });",
    '',
    '// Events are sent in batches: flush before the process or request ends.',
    'await panel.flush();',
  ].join('\n');
}

/** The same event over HTTP: a batch with `lib: "server"`, sent with a secret key. */
export function serverHttpSnippet(collectorUrl: string, libVersion = '0.2.0'): string {
  const body = `{"lib":"server","lib_version":"${libVersion}","events":[{"event_id":"renewal-8f3a2c1d","name":"Subscription renewed","ts":"2026-01-15T10:30:00Z","distinct_id":"user_123"}]}`;
  return [
    `curl -X POST ${collectorUrl}/v1/track \\`,
    '  -H "Authorization: Bearer $WELDPANEL_SECRET_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${body}'`,
  ].join('\n');
}
