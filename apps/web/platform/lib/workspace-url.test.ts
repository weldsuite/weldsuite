import { describe, expect, it } from 'vitest';
import {
  findWorkspace,
  isWorkspaceScopedPath,
  parseWorkspacePath,
  sameOriginPath,
  stripWorkspacePrefix,
  workspacePath,
} from './workspace-url';

const ORIGIN = 'https://app.weldsuite.org';

describe('parseWorkspacePath', () => {
  it('splits the ref from the inner path', () => {
    expect(parseWorkspacePath('/w/acme/weldcrm/customers/cus_1')).toEqual({
      ref: 'acme',
      rest: '/weldcrm/customers/cus_1',
    });
  });

  it('treats a bare workspace link as its home page', () => {
    expect(parseWorkspacePath('/w/acme')).toEqual({ ref: 'acme', rest: '/' });
    expect(parseWorkspacePath('/w/acme/')).toEqual({ ref: 'acme', rest: '/' });
  });

  it('decodes the ref and leaves the inner path encoded', () => {
    expect(parseWorkspacePath('/w/org_2Abc/weldmail/inbox%20x')).toEqual({
      ref: 'org_2Abc',
      rest: '/weldmail/inbox%20x',
    });
  });

  it('ignores other paths, including the /w9 form', () => {
    expect(parseWorkspacePath('/weldcrm/customers')).toBeNull();
    expect(parseWorkspacePath('/w9/token')).toBeNull();
    expect(parseWorkspacePath('/w/')).toBeNull();
    expect(parseWorkspacePath('/w/%E0%A4%A/x')).toBeNull();
  });
});

describe('findWorkspace', () => {
  const workspaces = [
    { id: 'org_2AbcDEF', slug: 'acme' },
    { id: 'org_2Xyz', slug: 'globex' },
    { id: 'org_noslug', slug: null },
  ];

  it('matches a slug, ignoring case', () => {
    expect(findWorkspace('acme', workspaces)?.id).toBe('org_2AbcDEF');
    expect(findWorkspace('GLOBEX', workspaces)?.id).toBe('org_2Xyz');
  });

  it('matches a Clerk org id exactly', () => {
    expect(findWorkspace('org_2AbcDEF', workspaces)?.slug).toBe('acme');
    expect(findWorkspace('org_noslug', workspaces)?.id).toBe('org_noslug');
    expect(findWorkspace('org_2abcdef', workspaces)).toBeNull();
  });

  it('returns null for a workspace the user is not in', () => {
    expect(findWorkspace('initech', workspaces)).toBeNull();
  });
});

describe('sameOriginPath', () => {
  it('keeps the path, query and hash', () => {
    expect(sameOriginPath('/weldcrm/customers?tab=notes#n1', ORIGIN)).toBe('/weldcrm/customers?tab=notes#n1');
  });

  it.each(['//evil.example', '/\\evil.example', '/\t/evil.example', 'https://evil.example/x'])(
    'falls back to / for %j, which would leave the origin',
    (path) => {
      expect(sameOriginPath(path, ORIGIN)).toBe('/');
    },
  );
});

describe('isWorkspaceScopedPath', () => {
  it.each(['/', '/weldcrm/customers', '/settings/team', '/apps/acme-app', '/objects/deals/rec_1', '/w9x'])(
    '%j is inside a workspace',
    (path) => {
      expect(isWorkspaceScopedPath(path)).toBe(true);
    },
  );

  it.each([
    '/auth/login',
    '/onboarding',
    '/invite',
    '/invite/accept',
    '/w9/token',
    '/w/acme/weldcrm',
    '/preview/weldcrm',
    '/welcome',
    '/call-room',
  ])('%j is not', (path) => {
    expect(isWorkspaceScopedPath(path)).toBe(false);
  });
});

describe('stripWorkspacePrefix', () => {
  it('returns the in-app path of a workspace link', () => {
    expect(stripWorkspacePrefix('/w/acme/weldcrm/customers')).toBe('/weldcrm/customers');
    expect(stripWorkspacePrefix('/w/acme')).toBe('/');
  });

  it('leaves other paths alone', () => {
    expect(stripWorkspacePrefix('/weldcrm/customers')).toBe('/weldcrm/customers');
    expect(stripWorkspacePrefix('/w9/token')).toBe('/w9/token');
  });
});

describe('workspacePath', () => {
  it('prefixes a path with the workspace', () => {
    expect(workspacePath('acme', '/weldcrm/customers?x=1')).toBe('/w/acme/weldcrm/customers?x=1');
    expect(workspacePath('acme')).toBe('/w/acme/');
    expect(workspacePath('acme', 'settings')).toBe('/w/acme/settings');
  });
});
