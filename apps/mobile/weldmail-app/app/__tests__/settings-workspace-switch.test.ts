import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Workspace switch must deactivate the push token against the *leaving*
 * tenant before Clerk setActive flips the JWT. Otherwise mail-inbound keeps
 * finding the Expo token in the previous workspace's device_tokens table.
 * Jest here is a Node runner and does not mount the settings screen, so this
 * guards the product decision at the source.
 */
describe('Settings workspace switch', () => {
  const src = readFileSync(join(__dirname, '../settings.tsx'), 'utf8');

  it('unregisters the device before switching workspace', () => {
    expect(src).toMatch(/prepareWorkspaceSwitch/);
    const switchFn = src.slice(src.indexOf('handleSwitchWorkspace'));
    const prepareIdx = switchFn.indexOf('prepareWorkspaceSwitch');
    const switchIdx = switchFn.indexOf('switchWorkspace(clerkOrgId)');
    expect(prepareIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(-1);
    expect(prepareIdx).toBeLessThan(switchIdx);
  });
});
