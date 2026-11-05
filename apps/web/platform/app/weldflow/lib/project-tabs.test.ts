import { describe, expect, it } from 'vitest';
import {
  hiddenProjectTabs,
  projectTabSettingsOf,
  type ProjectTabSettings,
} from '@weldsuite/app-api-client/schemas/project-tabs';
import { activeTabFor, nextTabPreference, shownTabIds } from './project-tabs';

const DEFAULTS = ['tasks', 'gantt', 'files', 'finance', 'settings'];

describe('shownTabIds', () => {
  it('shows every allowed tab without a saved preference', () => {
    expect(shownTabIds(null, ['tasks', 'files'])).toEqual(['tasks', 'files']);
  });

  it('keeps the saved order, limited to the allowed tabs', () => {
    expect(shownTabIds(['files', 'finance', 'tasks'], ['tasks', 'files', 'settings'])).toEqual(['files', 'tasks']);
  });

  it('falls back to every allowed tab when none of the saved ones is allowed', () => {
    expect(shownTabIds(['finance'], ['tasks', 'files'])).toEqual(['tasks', 'files']);
  });
});

describe('nextTabPreference', () => {
  it('keeps a tab this project hides at its place in the preference', () => {
    const allowed = ['tasks', 'gantt', 'files', 'settings'];
    // The user hides Gantt in a project where Finance is off.
    expect(nextTabPreference(null, DEFAULTS, ['tasks', 'files', 'settings'], allowed)).toEqual([
      'tasks',
      'files',
      'finance',
      'settings',
    ]);
  });

  it('keeps the saved preference when nothing is hidden here', () => {
    expect(nextTabPreference(['files', 'tasks'], DEFAULTS, ['tasks', 'files'], DEFAULTS)).toEqual(['tasks', 'files']);
  });

  it('does not bring back a tab the user hid themselves', () => {
    const saved = ['tasks', 'finance', 'settings'];
    const allowed = ['tasks', 'gantt', 'files', 'settings'];
    expect(nextTabPreference(saved, DEFAULTS, ['settings', 'tasks'], allowed)).toEqual(['settings', 'tasks', 'finance']);
  });
});

describe('activeTabFor', () => {
  it('reads the tab from the path, the project root being tasks', () => {
    expect(activeTabFor('/weldflow/project/p1', 'p1')).toBe('tasks');
    expect(activeTabFor('/weldflow/project/p1/finance/costs', 'p1')).toBe('finance');
  });
});

describe('hiddenProjectTabs', () => {
  const settings: ProjectTabSettings = {
    hidden: ['raid', 'settings'],
    roles: { member: ['finance'], viewer: ['finance', 'timesheet'] },
    members: [{ userId: 'user_custom', hidden: ['gantt'] }],
  };

  it('hides the project-wide tabs for admins, but keeps Settings', () => {
    expect([...hiddenProjectTabs(settings, { userId: 'user_a', role: 'admin', isAdmin: true })]).toEqual(['raid']);
  });

  it('adds the role default for members and viewers', () => {
    expect(hiddenProjectTabs(settings, { userId: 'user_m', role: 'member', isAdmin: false })).toEqual(
      new Set(['raid', 'settings', 'finance']),
    );
    expect(hiddenProjectTabs(settings, { userId: 'user_v', role: 'VIEWER', isAdmin: false })).toEqual(
      new Set(['raid', 'settings', 'finance', 'timesheet']),
    );
  });

  it("uses a member's own list in place of the role default", () => {
    expect(hiddenProjectTabs(settings, { userId: 'user_custom', role: 'viewer', isAdmin: false })).toEqual(
      new Set(['raid', 'settings', 'gantt']),
    );
  });
});

describe('projectTabSettingsOf', () => {
  it('reads a project without tab settings as nothing hidden', () => {
    expect(projectTabSettingsOf(null)).toEqual({ hidden: [], roles: { member: [], viewer: [] }, members: [] });
    expect(projectTabSettingsOf({ schedule: {} })).toEqual({ hidden: [], roles: { member: [], viewer: [] }, members: [] });
  });

  it('ignores malformed values', () => {
    expect(
      projectTabSettingsOf({ tabs: { hidden: ['raid', 4, 'raid'], roles: null, members: [{ hidden: [] }, { userId: 'u', hidden: 'x' }] } }),
    ).toEqual({ hidden: ['raid'], roles: { member: [], viewer: [] }, members: [{ userId: 'u', hidden: [] }] });
  });
});
