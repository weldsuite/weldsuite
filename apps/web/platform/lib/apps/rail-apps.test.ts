import { describe, expect, it } from 'vitest';
import type { InstalledApp } from '@/lib/api/apps';
import { WELDAGENT_RAIL_CODE, railAppHref, withAgentRailApp } from './rail-apps';

function installed(appCode: string, displayOrder: number): InstalledApp {
  return {
    id: `wsa_${appCode}`,
    workspaceId: 'ws_1',
    appCode,
    name: appCode,
    status: 'active',
    installedAt: '2026-01-01T00:00:00.000Z',
    displayOrder,
    appType: 'system',
  };
}

describe('railAppHref', () => {
  it('sends WeldAgent to /agents', () => {
    expect(railAppHref(WELDAGENT_RAIL_CODE)).toBe('/agents');
    expect(railAppHref(WELDAGENT_RAIL_CODE, 'system')).toBe('/agents');
  });

  it('hosts WeldApps under /apps and WeldObjects under /objects', () => {
    expect(railAppHref('my-app', 'user')).toBe('/apps/my-app');
    expect(railAppHref('fleet', 'object')).toBe('/objects/fleet');
  });

  it('gives first-party apps their own top-level route', () => {
    expect(railAppHref('weldcrm', 'system')).toBe('/weldcrm');
    expect(railAppHref('weldmail')).toBe('/weldmail');
  });
});

describe('withAgentRailApp', () => {
  const apps = [installed('weldcrm', 0), installed('weldmail', 1)];

  it('adds WeldAgent after the installed apps when the edition offers it', () => {
    const rail = withAgentRailApp(apps, { offered: true, name: 'AI Agents' });

    expect(rail.map((a) => a.appCode)).toEqual(['weldcrm', 'weldmail', WELDAGENT_RAIL_CODE]);
    expect(rail[2]).toMatchObject({ name: 'AI Agents', displayOrder: 2, appType: 'system', status: 'active' });
  });

  it('leaves the list alone when the edition has no agent module', () => {
    expect(withAgentRailApp(apps, { offered: false, name: 'AI Agents' })).toBe(apps);
  });

  it('never adds WeldAgent twice', () => {
    const withAgent = [...apps, installed(WELDAGENT_RAIL_CODE, 2)];
    expect(withAgentRailApp(withAgent, { offered: true, name: 'AI Agents' })).toBe(withAgent);
  });
});
