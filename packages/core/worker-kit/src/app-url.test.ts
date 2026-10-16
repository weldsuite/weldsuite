import { describe, expect, it } from 'vitest';
import { workspaceAppUrl } from './app-url';

describe('workspaceAppUrl', () => {
  it('puts the workspace in front of the path, keeping the query', () => {
    expect(workspaceAppUrl('https://app.weldsuite.org', 'org_2Abc', '/settings/billing?success=true')).toBe(
      'https://app.weldsuite.org/w/org_2Abc/settings/billing?success=true',
    );
  });

  it('tolerates trailing slashes on the base and a path without a leading one', () => {
    expect(workspaceAppUrl('https://app.weldsuite.org//', 'org_2Abc', 'weldhost/domains')).toBe(
      'https://app.weldsuite.org/w/org_2Abc/weldhost/domains',
    );
  });

  it('falls back to the bare link without an org id', () => {
    expect(workspaceAppUrl('https://app.weldsuite.org', null, '/settings/integrations/github')).toBe(
      'https://app.weldsuite.org/settings/integrations/github',
    );
  });
});
