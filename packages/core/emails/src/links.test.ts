import { describe, expect, it } from 'vitest';
import { workspaceAppUrl } from './links';

describe('workspaceAppUrl', () => {
  it('puts the workspace in front of the path', () => {
    expect(workspaceAppUrl('https://app.weldsuite.org', 'org_2Abc', '/weldflow/task/t_1')).toBe(
      'https://app.weldsuite.org/w/org_2Abc/weldflow/task/t_1',
    );
  });

  it('tolerates a trailing slash on the base and a path without a leading one', () => {
    expect(workspaceAppUrl(' https://app.weldsuite.org/ ', 'org_2Abc', 'settings/notifications')).toBe(
      'https://app.weldsuite.org/w/org_2Abc/settings/notifications',
    );
  });

  it('keeps query strings', () => {
    expect(workspaceAppUrl('https://app.weldsuite.org', 'org_2Abc', '/weldchat/c1?messageId=m1')).toBe(
      'https://app.weldsuite.org/w/org_2Abc/weldchat/c1?messageId=m1',
    );
  });

  it('falls back to the bare link without an org id', () => {
    expect(workspaceAppUrl('https://app.weldsuite.org', undefined, '/weldcalendar')).toBe(
      'https://app.weldsuite.org/weldcalendar',
    );
    expect(workspaceAppUrl('https://app.weldsuite.org', '', '/weldcalendar')).toBe(
      'https://app.weldsuite.org/weldcalendar',
    );
  });
});
