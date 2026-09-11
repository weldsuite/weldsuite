import { readFileSync } from 'fs';
import { join } from 'path';

describe('settings workspace switch', () => {
  const src = readFileSync(join(__dirname, '../settings/index.tsx'), 'utf8');

  it('unregisters only the app-api token before switching orgs', () => {
    expect(src).toMatch(/prepareWorkspaceSwitch/);
    const switchFn = src.slice(src.indexOf('const handleSwitchWorkspace'));
    const prepareIdx = switchFn.indexOf('prepareWorkspaceSwitch');
    const switchIdx = switchFn.indexOf('switchWorkspace(clerkOrgId)');
    expect(prepareIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(prepareIdx);
  });
});
