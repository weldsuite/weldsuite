import { describe, expect, it } from 'vitest';
import { selectOwnedProviderNumbers } from './phone-number-sync';

const ORG = 'org_mine';

function select(
  providerNumbers: Array<{ id: string; phone_number: string; customer_reference?: string | null }>,
  registry: Array<{ phoneNumber: string; clerkOrgId: string }> = [],
  tenantNumberIds: string[] = [],
  tenantProviderIds: string[] = [],
) {
  return selectOwnedProviderNumbers({ providerNumbers, registry, tenantNumberIds, tenantProviderIds, clerkOrgId: ORG });
}

describe('selectOwnedProviderNumbers', () => {
  it('keeps a number the registry assigns to this workspace', () => {
    const result = select(
      [{ id: 'tn_1', phone_number: '+31201234567' }],
      [{ phoneNumber: '+31201234567', clerkOrgId: ORG }],
    );
    expect(result.owned.map((n) => n.id)).toEqual(['tn_1']);
    expect(result.skipped).toBe(0);
  });

  it("skips another workspace's number, even when its customer_reference matches a local row", () => {
    const result = select(
      [{ id: 'tn_1', phone_number: '+31318259040', customer_reference: 'vpn_local' }],
      [{ phoneNumber: '+31318259040', clerkOrgId: 'org_other' }],
      ['vpn_local'],
    );
    expect(result.owned).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('skips an unregistered number that no order of this workspace placed', () => {
    const result = select(
      [
        { id: 'tn_1', phone_number: '+31318259040' },
        { id: 'tn_2', phone_number: '+31318259041', customer_reference: 'vpn_elsewhere' },
      ],
      [],
      ['vpn_local'],
    );
    expect(result.owned).toEqual([]);
    expect(result.skipped).toBe(2);
  });

  it('keeps an unregistered number ordered for one of this workspace\'s numbers', () => {
    const result = select(
      [{ id: 'tn_1', phone_number: '+31201234567', customer_reference: 'vpn_local' }],
      [],
      ['vpn_local'],
    );
    expect(result.owned.map((n) => n.id)).toEqual(['tn_1']);
  });

  it('keeps an unregistered number a row of this workspace already holds (a port whose registration failed)', () => {
    const result = select(
      [{ id: 'tn_ported', phone_number: '+31201234567', customer_reference: 'vpo_draft' }],
      [],
      ['vpn_local'],
      ['tn_ported'],
    );
    expect(result.owned.map((n) => n.id)).toEqual(['tn_ported']);
  });

  it("still skips another workspace's registered number, even when a row here holds its Telnyx id", () => {
    const result = select(
      [{ id: 'tn_ported', phone_number: '+31201234567' }],
      [{ phoneNumber: '+31201234567', clerkOrgId: 'org_other' }],
      [],
      ['tn_ported'],
    );
    expect(result.owned).toEqual([]);
  });

  it('matches registry rows on the normalized number', () => {
    const result = select(
      [{ id: 'tn_1', phone_number: '+31 20 123 4567' }],
      [{ phoneNumber: '+31201234567', clerkOrgId: 'org_other' }],
    );
    expect(result.owned).toEqual([]);
  });
});
