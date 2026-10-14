import { describe, it, expect } from 'vitest';
import type { Company } from '@weldsuite/app-api-client/schemas/companies';
import { companyColumns } from './company-grid-config';

function column(id: string) {
  const col = companyColumns.find((c) => c.id === id);
  if (!col) throw new Error(`no column ${id}`);
  return col;
}

const company = (overrides: Partial<Company> = {}) => ({ id: 'cmp_1', displayName: 'Acme', ...overrides }) as Company;

describe('company grid columns', () => {
  it('lets the Primary Address cell be edited', () => {
    const location = column('location');
    expect(location.editable).not.toBe(false);
    expect(location.setValue).toBeTypeOf('function');
  });

  it('keeps the street and postal code when the address cell changes city/state/country', () => {
    const c = company({
      primaryAddress: { line1: 'Keizersgracht 12', postalCode: '1015 CJ', city: 'Amsterdam', country: 'NL' },
    });
    expect(column('location').setValue!(c, { city: 'Utrecht', state: '', country: 'NL' })).toEqual({
      primaryAddress: { line1: 'Keizersgracht 12', postalCode: '1015 CJ', city: 'Utrecht', state: undefined, country: 'NL' },
    });
  });

  it('reads a stored province as the state, and writes it back as state', () => {
    const c = company({ primaryAddress: { city: 'Antwerp', province: 'Antwerpen', country: 'BE' } });
    expect(column('location').getValue(c)).toEqual({ city: 'Antwerp', state: 'Antwerpen', country: 'BE' });
    expect(column('location').setValue!(c, { city: 'Antwerp', state: 'Antwerpen', country: 'BE' })).toEqual({
      primaryAddress: { city: 'Antwerp', state: 'Antwerpen', country: 'BE' },
    });
  });

  it('sends an empty string when a text cell is cleared, so the PATCH actually clears it', () => {
    // `undefined` would be dropped from the JSON body and the old value would come back.
    for (const id of ['email', 'phone', 'industry', 'website', 'description', 'employeeCount', 'angellistUrl', 'facebookUrl', 'instagramUrl', 'linkedinUrl', 'twitterHandle']) {
      const update = column(id).setValue!(company(), '');
      expect(Object.values(update)).toEqual(['']);
    }
  });

  it("offers Attio's company attributes, in Attio's order, at the top level of the Add menu", () => {
    const topLevel = companyColumns.filter((c) => c.visible === false && !c.menuParentId).map((c) => c.name);
    // Domains and Primary location are default columns, so they're showing, not in the menu.
    expect(topLevel).toEqual([
      'Record ID',
      'Name',
      'Description',
      'Team',
      'Categories',
      'AngelList',
      'Facebook',
      'Instagram',
      'LinkedIn',
      'Twitter',
      'Twitter follower count',
      'Estimated ARR',
      'Funding raised',
      'Foundation date',
      'Employee range',
      'First interaction',
      'Last interaction',
      'Next interaction',
      'Connection strength',
      'Strongest connection',
      'Next due task',
      'Associated deals',
      'Associated workspaces',
      'Created at',
      'Created by',
    ]);
    // …and the visible defaults sit in Attio's order between them.
    const attio = companyColumns.filter((c) => !c.menuParentId).map((c) => c.name);
    expect(attio.indexOf('Domains')).toBe(attio.indexOf('Record ID') + 1);
    expect(attio.indexOf('Primary location')).toBe(attio.indexOf('Categories') + 1);
  });

  it('nests sub-attributes under their parent, with a parent that exists', () => {
    const ids = new Set(companyColumns.map((c) => c.id));
    const children = companyColumns.filter((c) => c.menuParentId);
    for (const child of children) expect(ids.has(child.menuParentId!)).toBe(true);
    expect(children.filter((c) => c.menuParentId === 'location').map((c) => c.name)).toEqual(['City', 'State', 'Country']);
  });

  it('shows the domain, not the URL, and keeps the stored currency for money', () => {
    expect(column('website').getValue(company({ website: 'https://acme.com/' }))).toBe('acme.com');
    const c = company({ fundingRaised: { amount: 1, currency: 'USD' } });
    expect(column('fundingRaised').setValue!(c, 2_500_000)).toEqual({ fundingRaised: { amount: 2_500_000, currency: 'USD' } });
    expect(column('annualRevenue').setValue!(company(), 900)).toEqual({ annualRevenue: { amount: 900, currency: 'EUR' } });
    expect(column('annualRevenue').setValue!(c, 0)).toEqual({ annualRevenue: null });
  });

  it('edits one part of the primary location without touching the rest', () => {
    const c = company({ primaryAddress: { line1: 'Main 1', city: 'Essen', country: 'DE' } });
    expect(column('location.city').setValue!(c, 'Duisburg')).toEqual({
      primaryAddress: { line1: 'Main 1', city: 'Duisburg', state: undefined, country: 'DE' },
    });
  });

  it('fills state and country too when a city is picked from Mapbox in the City cell', () => {
    const c = company({ primaryAddress: { line1: 'Main 1', city: 'Essen', state: 'NRW', country: 'DE' } });
    expect(column('location.city').locationPart).toBe('city');
    expect(column('location.city').setValue!(c, { city: 'Antwerp', state: 'Antwerp', country: 'BE' })).toEqual({
      primaryAddress: { line1: 'Main 1', city: 'Antwerp', state: 'Antwerp', country: 'BE' },
    });
    // A pick that knows only the country leaves the rest alone.
    expect(column('location.country').setValue!(c, { city: '', state: '', country: 'NL' })).toEqual({
      primaryAddress: { line1: 'Main 1', city: 'Essen', state: 'NRW', country: 'NL' },
    });
  });

  it('reads computed attributes, and leaves rows without them empty', () => {
    const c = company({
      attributes: {
        team: [{ id: 'p1', name: 'Ada', email: 'ada@acme.com', phone: null, jobTitle: 'CTO' }],
        firstInteraction: null,
        lastInteraction: { at: '2026-10-01T10:00:00.000Z', type: 'email', userId: 'user_b' },
        nextInteraction: null,
        connectionStrength: 'good',
        strongestConnectionUserId: 'user_b',
        nextDueTask: { id: 't1', title: 'Send proposal', dueDate: '2026-10-20T00:00:00.000Z' },
        deals: [{ id: 'd1', name: 'Renewal', stage: 'closed_won', status: 'won', amount: 100, currency: 'EUR', closeDate: null, ownerId: 'user_b' }],
      },
    });
    expect(column('team').getValue(c)).toEqual(['Ada']);
    expect(column('team.email').getValue(c)).toBe('ada@acme.com');
    expect(column('lastInteraction').getValue(c)).toBe('2026-10-01T10:00:00.000Z');
    expect(column('lastInteraction.type').getValue(c)).toBe('email');
    expect(column('connectionStrength').getValue(c)).toBe('good');
    expect(column('strongestConnection').getValue(c)).toBe('user_b');
    expect(column('nextDueTask').getValue(c)).toBe('Send proposal');
    expect(column('deals').getValue(c)).toEqual(['Renewal']);
    expect(column('deals.stage').getValue(c)).toEqual(['Closed won']);
    expect(column('team').getValue(company())).toEqual([]);
    expect(column('connectionStrength').getValue(company())).toBeNull();
  });
});
