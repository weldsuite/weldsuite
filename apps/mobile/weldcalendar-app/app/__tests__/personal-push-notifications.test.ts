import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Personal calendar events would never raise a notification if device tokens
 * lived only in the tenant DB (app-api). These source guards lock the dual
 * registration: personal-only users have no Clerk org, and switching orgs
 * must not silence personal reminders.
 */
describe('Personal calendar notifications', () => {
  const notificationContext = readFileSync(
    join(__dirname, '../../contexts/NotificationContext.tsx'),
    'utf8',
  );

  it('registers the device with personal-api, not only app-api', () => {
    expect(notificationContext).toMatch(/personalApi\.pushTokens\.register/);
    expect(notificationContext).toMatch(/appApi\.pushTokens\.register/);
  });

  it('does not gate token registration on a Clerk org', () => {
    expect(notificationContext).not.toMatch(/if \(!user \|\| !organizationId\)/);
    expect(notificationContext).toMatch(/if \(!user\) \{/);
  });

  it('keeps the personal token alive across a workspace switch', () => {
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

  it('switches org before opening a workspace event from a tap', () => {
    expect(notificationContext).toMatch(/clerkOrgId/);
    expect(notificationContext).toMatch(/setActive\(\{ organization: tapOrgId \}\)/);
  });
});
