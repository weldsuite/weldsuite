import { describe, it, expect } from 'vitest';
import {
  catchAllRegistryEmail,
  expandCatchAllCandidates,
  isCatchAllRegistryEmail,
  isSharedWeldMailDomain,
} from './catch-all';

describe('catchAllRegistryEmail', () => {
  it('builds a lower-cased *@domain sentinel', () => {
    expect(catchAllRegistryEmail('Example.COM')).toBe('*@example.com');
  });
});

describe('isSharedWeldMailDomain', () => {
  it('detects apex and workspace subdomains', () => {
    expect(isSharedWeldMailDomain('weldmail.com')).toBe(true);
    expect(isSharedWeldMailDomain('acme.weldmail.com')).toBe(true);
    expect(isSharedWeldMailDomain('custom.com')).toBe(false);
  });
});

describe('isCatchAllRegistryEmail', () => {
  it('detects sentinel addresses', () => {
    expect(isCatchAllRegistryEmail('*@custom.com')).toBe(true);
    expect(isCatchAllRegistryEmail('hello@custom.com')).toBe(false);
  });
});

describe('expandCatchAllCandidates', () => {
  it('skips exact-matched recipients', () => {
    const matched = new Set(['hello@custom.com']);
    expect(
      expandCatchAllCandidates(['hello@custom.com', 'sales@custom.com'], matched),
    ).toEqual(['*@custom.com']);
  });

  it('skips shared WeldMail domains', () => {
    expect(
      expandCatchAllCandidates(['x@acme.weldmail.com', 'y@weldmail.com'], new Set()),
    ).toEqual([]);
  });

  it('dedupes candidates across addresses on the same domain', () => {
    expect(
      expandCatchAllCandidates(['a@custom.com', 'b@custom.com'], new Set()),
    ).toEqual(['*@custom.com']);
  });

  it('ignores malformed addresses', () => {
    expect(expandCatchAllCandidates(['', '@nodomain', 'nolocal@'], new Set())).toEqual([]);
  });
});
