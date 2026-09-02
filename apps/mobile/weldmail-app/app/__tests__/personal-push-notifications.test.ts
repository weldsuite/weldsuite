import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A personal @weldmail.com address delivered mail but never raised a
 * notification: device tokens lived only in the tenant DB (app-api), which a
 * personal account has no access to, and the realtime socket was org-keyed so
 * the per-user personal hub was unreachable.
 *
 * These source guards lock the fix. They are deliberately text-level, matching
 * `personal-workspace-coexistence.test.ts` — the point is to catch someone
 * quietly reverting the decision, not to re-test Expo or Clerk.
 */
describe('Personal mail notifications', () => {
  const notificationContext = readFileSync(
    join(__dirname, '../../contexts/NotificationContext.tsx'),
    'utf8',
  );
  const layout = readFileSync(join(__dirname, '../_layout.tsx'), 'utf8');
  const personalRealtime = readFileSync(
    join(__dirname, '../../hooks/usePersonalMailRealtime.ts'),
    'utf8',
  );

  it('registers the device with personal-api, not only app-api', () => {
    expect(notificationContext).toMatch(/personalApi\.pushTokens\.register/);
    expect(notificationContext).toMatch(/appApi\.pushTokens\.register/);
  });

  it('does not gate token registration on a Clerk org', () => {
    // A personal-only user has no org; `if (!user || !organizationId) return`
    // left them with no token registered anywhere.
    expect(notificationContext).not.toMatch(/if \(!user \|\| !organizationId\) return;/);
    expect(notificationContext).toMatch(/if \(!user\) return;/);
  });

  it('re-registers once the personal account resolves', () => {
    // `hasPersonalAccount` is usually still false on the first pass, so it has
    // to be a dependency of the registration effect.
    expect(notificationContext).toMatch(/hasPersonalAccount,\s*getCredentials\]/);
  });

  it('keeps the personal token alive across a workspace switch', () => {
    // Switching orgs must not silence the personal inbox, so
    // prepareWorkspaceSwitch cannot simply alias unregisterDevice.
    expect(notificationContext).not.toMatch(/const prepareWorkspaceSwitch = unregisterDevice;/);
    expect(notificationContext).toMatch(/const prepareWorkspaceSwitch = async \(\)/);
  });

  it('deactivates both tokens on full sign-out', () => {
    const unregister = notificationContext.slice(
      notificationContext.indexOf('const unregisterDevice'),
      notificationContext.indexOf('const prepareWorkspaceSwitch'),
    );
    expect(unregister).toMatch(/appApi\.pushTokens\.unregister/);
    expect(unregister).toMatch(/personalApi\.pushTokens\.unregister/);
  });

  it('opens the per-user personal realtime hub for in-app updates', () => {
    expect(personalRealtime).toMatch(/\/ws\/personal/);
    expect(personalRealtime).toMatch(/mail\.\$\{userId\}/);
    // Don't hold a socket open for a user with no personal address.
    expect(personalRealtime).toMatch(/hasPersonalAccount/);
    expect(layout).toMatch(/usePersonalMailRealtime\(\)/);
  });
});
