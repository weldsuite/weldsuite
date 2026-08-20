import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Mail works over REST. A slow or failed websocket (cold start, notification
 * tap, token refresh) must not flash a reconnecting banner — the socket retries
 * in the background with no UI. Jest here is a Node runner and does not mount
 * RN components, so this guards the product decision at the provider source.
 */
describe('RealtimeProvider', () => {
  const src = readFileSync(join(__dirname, '../realtime-provider.tsx'), 'utf8');

  it('does not mount a reconnecting or connecting status banner', () => {
    expect(src).not.toMatch(/RealtimeStatusBanner/);
    expect(src).not.toMatch(/Reconnecting/);
  });

  it('does not keep the unused banner component', () => {
    expect(existsSync(join(__dirname, '../../components/RealtimeStatusBanner.tsx'))).toBe(false);
  });

  it('remounts the realtime client when the active organization changes', () => {
    // WorkspaceHub is org-scoped; keying only by userId left the previous
    // workspace's mail socket alive after a Clerk setActive switch.
    expect(src).toMatch(/\$\{user\.id\}:\$\{organizationId/);
  });
});
