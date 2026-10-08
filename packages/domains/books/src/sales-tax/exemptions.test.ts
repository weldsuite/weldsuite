import { describe, expect, it } from 'vitest';
import { getCertificateRules, shippingTaxability } from '../jurisdictions/us/states';
import {
  certificateExpiry,
  missingCertificateCureDeadline,
  resolveExemptionCertificate,
} from './exemptions';
import { certificate } from './test-fixtures';

const resolve = (certs: ReturnType<typeof certificate>[], stateCode: string, date: string, invoiceId?: string) =>
  resolveExemptionCertificate(certs, { stateCode, date, invoiceId });

describe('certificate expiry per state', () => {
  it('Florida: the annual resale certificate ends on 31 December of its year', () => {
    const cert = certificate({ states: ['FL'], issuedOn: '2026-03-10', expiresOn: null });
    expect(certificateExpiry(cert, 'FL')).toBe('2026-12-31');
    expect(resolve([cert], 'FL', '2026-12-31').valid).toBe(true);
    const after = resolve([cert], 'FL', '2027-01-01');
    expect(after).toMatchObject({ valid: false, reason: 'certificate_expired' });
  });

  it('Florida: the rule is for resale certificates only', () => {
    const cert = certificate({ states: ['FL'], reason: 'nonprofit', issuedOn: '2020-03-10' });
    expect(certificateExpiry(cert, 'FL')).toBeNull();
    expect(resolve([cert], 'FL', '2030-01-01').valid).toBe(true);
  });

  it('Washington: a reseller permit lasts 48 months', () => {
    const cert = certificate({ states: ['WA'], issuedOn: '2026-02-15' });
    expect(certificateExpiry(cert, 'WA')).toBe('2030-02-15');
    expect(resolve([cert], 'WA', '2030-02-15').valid).toBe(true);
    expect(resolve([cert], 'WA', '2030-02-16')).toMatchObject({ valid: false, reason: 'certificate_expired' });
  });

  it('an explicit expiry date wins over the state rule', () => {
    const cert = certificate({ states: ['WA'], issuedOn: '2026-02-15', expiresOn: '2027-02-15' });
    expect(certificateExpiry(cert, 'WA')).toBe('2027-02-15');
    expect(resolve([cert], 'WA', '2027-02-16')).toMatchObject({ valid: false, reason: 'certificate_expired' });
  });

  it('SST blanket certificate: valid while purchases are no more than 12 months apart', () => {
    const cert = certificate({ states: ['OH'], form: 'sst_f0003', issuedOn: '2025-01-10', lastUsedOn: '2025-11-20' });
    expect(certificateExpiry(cert, 'OH')).toBe('2026-11-20');
    expect(resolve([cert], 'OH', '2026-11-20').valid).toBe(true);
    expect(resolve([cert], 'OH', '2026-11-21')).toMatchObject({ valid: false, reason: 'certificate_expired' });
  });

  it('SST blanket certificate: counts from the issue date when never used', () => {
    const cert = certificate({ states: ['OH'], form: 'sst_f0003', issuedOn: '2025-01-10', lastUsedOn: null });
    expect(certificateExpiry(cert, 'OH')).toBe('2026-01-10');
  });

  it('the SST rule is for the SST form on SST states only', () => {
    expect(certificateExpiry(certificate({ states: ['OH'], form: 'state_form', issuedOn: '2020-01-01' }), 'OH')).toBeNull();
    expect(certificateExpiry(certificate({ states: ['TX'], form: 'sst_f0003', issuedOn: '2020-01-01' }), 'TX')).toBeNull();
    expect(getCertificateRules('OH').some((r) => r.forms?.includes('sst_f0003'))).toBe(true);
    expect(getCertificateRules('TX')).toEqual([]);
  });

  it('every other state: no expiry unless the certificate says so', () => {
    const cert = certificate({ states: ['TX'], issuedOn: '2010-01-01' });
    expect(certificateExpiry(cert, 'TX')).toBeNull();
    expect(resolve([cert], 'TX', '2040-01-01').valid).toBe(true);
  });
});

describe('resolveExemptionCertificate', () => {
  it('needs the state to be covered, case-insensitively', () => {
    const cert = certificate({ states: ['fl', 'tx'] });
    expect(resolve([cert], 'FL', '2026-03-15').valid).toBe(true);
    expect(resolve([cert], 'tx', '2026-03-15').valid).toBe(true);
    expect(resolve([cert], 'CA', '2026-03-15')).toEqual({ valid: false, reason: 'certificate_missing' });
  });

  it('is not valid before its issue date', () => {
    const cert = certificate({ issuedOn: '2026-05-01' });
    expect(resolve([cert], 'FL', '2026-04-30')).toMatchObject({ valid: false, reason: 'certificate_missing' });
    expect(resolve([cert], 'FL', '2026-05-01').valid).toBe(true);
  });

  it('is not valid while pending or after it was revoked', () => {
    expect(resolve([certificate({ status: 'pending' })], 'FL', '2026-03-15')).toMatchObject({
      valid: false,
      reason: 'certificate_missing',
    });
    expect(resolve([certificate({ status: 'revoked' })], 'FL', '2026-03-15')).toMatchObject({
      valid: false,
      reason: 'certificate_missing',
    });
  });

  it('a status of expired is expired whatever the dates say', () => {
    expect(resolve([certificate({ status: 'expired' })], 'FL', '2026-03-15')).toMatchObject({
      valid: false,
      reason: 'certificate_expired',
    });
  });

  it('a single-purchase certificate covers only its own invoice', () => {
    const cert = certificate({ blanket: false, invoiceId: 'inv_7' });
    expect(resolve([cert], 'FL', '2026-03-15', 'inv_8')).toMatchObject({ valid: false, reason: 'certificate_missing' });
    expect(resolve([cert], 'FL', '2026-03-15')).toMatchObject({ valid: false });
    expect(resolve([cert], 'FL', '2026-03-15', 'inv_7').valid).toBe(true);
  });

  it('prefers the certificate made for the invoice, then the one that lasts longest', () => {
    const states = ['TX'];
    const blanket = certificate({ id: 'b', states, expiresOn: '2030-01-01' });
    const single = certificate({ id: 's', states, blanket: false, invoiceId: 'inv_1', expiresOn: '2026-12-31' });
    const longer = certificate({ id: 'l', states, expiresOn: null });
    const first = resolve([blanket, single], 'TX', '2026-03-15', 'inv_1');
    expect(first.valid && first.certificate.id).toBe('s');
    const second = resolve([blanket, longer], 'TX', '2026-03-15');
    expect(second.valid && second.certificate.id).toBe('l');
  });

  it('reports the expired candidate when no other certificate is valid', () => {
    const old = certificate({ id: 'old', expiresOn: '2025-12-31' });
    const result = resolve([old], 'FL', '2026-03-15');
    expect(result).toMatchObject({ valid: false, reason: 'certificate_expired', candidate: { id: 'old' } });
  });

  it('a valid certificate beats an expired one', () => {
    const old = certificate({ id: 'old', expiresOn: '2025-12-31' });
    const current = certificate({ id: 'new', expiresOn: '2027-12-31' });
    const result = resolve([old, current], 'FL', '2026-03-15');
    expect(result.valid && result.certificate.id).toBe('new');
  });
});

describe('missing certificate cure deadline', () => {
  it('is 90 days after the sale (SST)', () => {
    expect(missingCertificateCureDeadline('2026-01-01')).toBe('2026-04-01');
    expect(missingCertificateCureDeadline('2026-03-15')).toBe('2026-06-13');
    expect(missingCertificateCureDeadline('2026-11-15')).toBe('2027-02-13');
    expect(missingCertificateCureDeadline('2026-03-15T10:00:00.000Z')).toBe('2026-06-13');
  });
});

describe('shipping taxability defaults', () => {
  it('lists taxable, exempt and California states', () => {
    expect(shippingTaxability('TX')).toEqual({ shipping: 'taxable', handling: 'taxable' });
    expect(shippingTaxability('az').shipping).toBe('exempt_if_separate');
    expect(shippingTaxability('CA')).toEqual({ shipping: 'exempt_if_separate', handling: 'taxable' });
    expect(shippingTaxability('FL')).toEqual({ shipping: 'follows_goods', handling: 'follows_goods' });
    expect(shippingTaxability(null)).toEqual({ shipping: 'follows_goods', handling: 'follows_goods' });
  });
});
