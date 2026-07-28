import { describe, it, expect } from 'vitest';
import {
  externalIdOf,
  isDeletedRecord,
  mapNangoRecord,
  normaliseStage,
  statusForStage,
} from './mappers';

describe('externalIdOf', () => {
  it('reads the Nango record id', () => {
    expect(externalIdOf({ id: '0011t00000abc' })).toBe('0011t00000abc');
  });

  it('falls back to the HubSpot object id', () => {
    expect(externalIdOf({ properties: { hs_object_id: '451' } })).toBe('451');
  });

  it('returns null when there is no identifier to map on', () => {
    expect(externalIdOf({ name: 'Acme' })).toBeNull();
    expect(externalIdOf({ id: '   ' })).toBeNull();
  });
});

describe('isDeletedRecord', () => {
  it('detects both delete markers Nango uses', () => {
    expect(isDeletedRecord({ _nango_metadata: { last_action: 'DELETED' } })).toBe(true);
    expect(isDeletedRecord({ _nango_metadata: { deleted_at: '2026-07-01T00:00:00Z' } })).toBe(true);
  });

  it('treats live records as live', () => {
    expect(isDeletedRecord({ _nango_metadata: { last_action: 'UPDATED', deleted_at: null } })).toBe(false);
    expect(isDeletedRecord({})).toBe(false);
  });
});

describe('normaliseStage', () => {
  it('maps HubSpot and Salesforce stages onto WeldCRM stages', () => {
    expect(normaliseStage('appointmentscheduled')).toBe('prospecting');
    expect(normaliseStage('contractsent')).toBe('negotiation');
    expect(normaliseStage('Needs Analysis')).toBe('needs_analysis');
    expect(normaliseStage('Negotiation/Review')).toBe('negotiation');
  });

  it('recognises won and lost by substring for custom pipelines', () => {
    expect(normaliseStage('Closed Won - Renewal')).toBe('closed_won');
    expect(normaliseStage('closed_lost_no_budget')).toBe('closed_lost');
  });

  it('falls back to prospecting rather than dropping the opportunity', () => {
    expect(normaliseStage('Some Custom Stage')).toBe('prospecting');
    expect(normaliseStage(null)).toBe('prospecting');
  });
});

describe('statusForStage', () => {
  it('derives open/won/lost', () => {
    expect(statusForStage('closed_won')).toBe('won');
    expect(statusForStage('closed_lost')).toBe('lost');
    expect(statusForStage('negotiation')).toBe('open');
  });
});

describe('mapNangoRecord — company', () => {
  it('maps a Salesforce account', () => {
    const mapped = mapNangoRecord('company', {
      id: '0011t00000abc',
      name: 'Acme Industrial',
      website: 'acme.example',
      industry: 'Manufacturing',
      description: 'Long-standing account',
      no_employees: '250',
      billing_city: 'Rotterdam',
      billing_country: 'NL',
    });

    expect(mapped).toMatchObject({
      entity: 'company',
      externalId: '0011t00000abc',
      values: {
        name: 'Acme Industrial',
        displayName: 'Acme Industrial',
        website: 'acme.example',
        industry: 'Manufacturing',
        employeeCount: '250',
        notes: 'Long-standing account',
        primaryAddress: { city: 'Rotterdam', country: 'NL' },
      },
    });
  });

  it('maps a HubSpot company from nested properties', () => {
    const mapped = mapNangoRecord('company', {
      id: '451',
      properties: { name: 'Beta BV', domain: 'beta.example', phone: '+31201234567' },
    });

    expect(mapped?.values).toMatchObject({
      name: 'Beta BV',
      website: 'beta.example',
      phone: '+31201234567',
    });
  });

  it('drops a company with no name — the row would be unusable', () => {
    expect(mapNangoRecord('company', { id: '1', website: 'x.example' })).toBeNull();
  });

  it('omits absent fields entirely so an update never blanks curated data', () => {
    const mapped = mapNangoRecord('company', { id: '1', name: 'Acme' });
    expect(mapped?.values).not.toHaveProperty('phone');
    expect(mapped?.values).not.toHaveProperty('primaryAddress');
  });
});

describe('mapNangoRecord — person', () => {
  it('maps a contact and composes the display name', () => {
    const mapped = mapNangoRecord('person', {
      id: '0031t00000xyz',
      first_name: 'Jelle',
      last_name: 'de Vries',
      email: 'jelle@acme.example',
      phone: '+31612345678',
      job_title: 'Head of Operations',
      account_id: '0011t00000abc',
    });

    expect(mapped).toMatchObject({
      entity: 'person',
      accountExternalId: '0011t00000abc',
      values: {
        firstName: 'Jelle',
        lastName: 'de Vries',
        fullName: 'Jelle de Vries',
        displayName: 'Jelle de Vries',
        email: 'jelle@acme.example',
        directPhone: '+31612345678',
        title: 'Head of Operations',
      },
    });
  });

  it('falls back to the email when the provider sent no name', () => {
    const mapped = mapNangoRecord('person', { id: '1', email: 'nameless@acme.example' });
    expect(mapped?.values.displayName).toBe('nameless@acme.example');
  });

  it('drops a contact with neither a name nor an email', () => {
    expect(mapNangoRecord('person', { id: '1', phone: '+31612345678' })).toBeNull();
  });

  it('reads the HubSpot association id for the employer', () => {
    const mapped = mapNangoRecord('person', {
      id: '9',
      properties: { firstname: 'Ana', lastname: 'Silva', associatedcompanyid: '451' },
    });
    expect(mapped).toMatchObject({ entity: 'person', accountExternalId: '451' });
  });
});

describe('mapNangoRecord — opportunity', () => {
  it('maps a HubSpot deal including amount, stage and close date', () => {
    const mapped = mapNangoRecord('opportunity', {
      id: 'deal-1',
      dealname: 'Acme retrofit',
      amount: '12500.50',
      dealstage: 'contractsent',
      closedate: '2026-09-30T00:00:00Z',
      company_id: '451',
      deal_currency_code: 'EUR',
    });

    expect(mapped).toMatchObject({
      entity: 'opportunity',
      accountExternalId: '451',
      values: {
        name: 'Acme retrofit',
        amount: '12500.5',
        currency: 'EUR',
        stage: 'negotiation',
        status: 'open',
      },
    });
    expect((mapped as unknown as { values: { closeDate: Date } }).values.closeDate.toISOString()).toBe(
      '2026-09-30T00:00:00.000Z',
    );
  });

  it('parses an epoch-millisecond close date', () => {
    const mapped = mapNangoRecord('opportunity', {
      id: 'deal-2',
      name: 'Epoch deal',
      closedate: '1790000000000',
    });
    const closeDate = (mapped as unknown as { values: { closeDate: Date } }).values.closeDate;
    expect(closeDate.getTime()).toBe(1790000000000);
  });

  it('defaults a missing close date rather than failing the NOT NULL column', () => {
    const mapped = mapNangoRecord('opportunity', { id: 'deal-3', name: 'No date' });
    const closeDate = (mapped as unknown as { values: { closeDate: Date } }).values.closeDate;
    expect(closeDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('defaults a missing amount to zero and EUR', () => {
    const mapped = mapNangoRecord('opportunity', { id: 'deal-4', name: 'No amount' });
    expect(mapped?.values).toMatchObject({ amount: '0', currency: 'EUR' });
  });

  it('marks a won deal as won', () => {
    const mapped = mapNangoRecord('opportunity', { id: 'deal-5', name: 'Won', stage: 'closedwon' });
    expect(mapped?.values).toMatchObject({ stage: 'closed_won', status: 'won' });
  });

  it('drops a deal with no name', () => {
    expect(mapNangoRecord('opportunity', { id: 'deal-6', amount: '10' })).toBeNull();
  });
});
