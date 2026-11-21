import { describe, expect, it } from 'vitest';
import { businessSettingsPayload, type BusinessSettingsFormValues } from './business-settings-payload';

const loaded: BusinessSettingsFormValues = {
  timezone: 'Europe/Amsterdam',
  legalName: 'Acme B.V.',
  tradingName: '',
  contactFirstName: '',
  contactLastName: '',
  email: '',
  phone: '',
  addressLine1: 'Damrak 1',
  addressLine2: '',
  city: 'Amsterdam',
  state: '',
  postalCode: '1012 LG',
  countryCode: 'NL',
  taxId: 'NL123456789B01',
  registrationNumber: '12345678',
};

describe('businessSettingsPayload', () => {
  it('sends only the changed fields, never the untouched VAT and registration numbers (TASK-1464)', () => {
    const payload = businessSettingsPayload(
      { ...loaded, tradingName: 'E2E Trading', contactFirstName: 'Jan', addressLine1: 'Keizersgracht 100' },
      loaded,
    );
    expect(payload).toEqual({
      tradingName: 'E2E Trading',
      contactFirstName: 'Jan',
      addressLine1: 'Keizersgracht 100',
      country: 'NL',
    });
    expect(payload).not.toHaveProperty('vatNumber');
    expect(payload).not.toHaveProperty('registrationNumber');
  });

  it('sends a field the member emptied as null', () => {
    expect(businessSettingsPayload({ ...loaded, taxId: '  ' }, loaded)).toEqual({ vatNumber: null, country: 'NL' });
  });

  it('sends nothing when nothing changed', () => {
    expect(businessSettingsPayload({ ...loaded, city: ' Amsterdam ' }, loaded)).toEqual({});
  });

  it('sends a changed timezone or country on its own', () => {
    expect(businessSettingsPayload({ ...loaded, timezone: 'Europe/Brussels' }, loaded)).toEqual({ timezone: 'Europe/Brussels' });
    expect(businessSettingsPayload({ ...loaded, countryCode: 'BE' }, loaded)).toEqual({ country: 'BE' });
  });

  it('sends the form defaults on a first save, when nothing was stored', () => {
    expect(
      businessSettingsPayload({ ...loaded, legalName: '', addressLine1: '', city: '', postalCode: '', taxId: '', registrationNumber: '' }, { countryCode: '' }),
    ).toEqual({ timezone: 'Europe/Amsterdam', country: 'NL' });
  });
});
