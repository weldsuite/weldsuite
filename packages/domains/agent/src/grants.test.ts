import { describe, expect, it } from 'vitest';
import { grantableAgentPermissions, splitGrantable } from './grants';

describe('grantableAgentPermissions', () => {
  it('offers data objects and the sandbox/web grants, not self-management', () => {
    const keys = grantableAgentPermissions();
    expect(keys).toContain('tasks:read');
    expect(keys).toContain('computer:use');
    expect(keys.some((k) => k.startsWith('weldagent:') || k.startsWith('billing:'))).toBe(false);
  });
});

describe('splitGrantable', () => {
  it('grants only what the granter holds and the catalog offers', () => {
    const result = splitGrantable(['tasks:read', 'tickets:update', 'billing:manage', 'nope:read'], {
      permissions: ['tasks:read', 'billing:manage'],
    });
    expect(result.granted).toEqual(['tasks:read']);
    expect(result.refused.sort()).toEqual(['billing:manage', 'nope:read', 'tickets:update']);
  });

  it('counts wildcard grants', () => {
    expect(splitGrantable(['tasks:read'], { permissions: ['*'] }).granted).toEqual(['tasks:read']);
  });
});
