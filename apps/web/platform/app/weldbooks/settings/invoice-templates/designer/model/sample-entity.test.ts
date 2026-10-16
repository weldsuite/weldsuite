import { describe, expect, it } from 'vitest';
import { withSampleContent, type SampleTexts } from './sample-entity';

const samples: SampleTexts = {
  entityName: 'Your company',
  footerText: 'Thanks',
  paymentInstructions: 'Pay please',
  terms: 'Terms',
  bankName: 'Sample Bank',
};

describe('withSampleContent', () => {
  it('fills in everything for a missing entity', () => {
    const entity = withSampleContent(undefined, samples);
    expect(entity.name).toBe('Your company');
    expect(entity.branding?.footerText).toBe('Thanks');
    expect(entity.bankDetails?.iban).toBeTruthy();
  });

  it('keeps what the company has filled in', () => {
    const entity = withSampleContent(
      {
        name: 'Real BV',
        branding: { footerText: 'Real footer', logoUrl: 'https://example.com/logo.png' },
        bankDetails: { iban: 'DE89 3704 0044 0532 0130 00' },
      },
      samples,
    );
    expect(entity.name).toBe('Real BV');
    expect(entity.branding?.footerText).toBe('Real footer');
    expect(entity.branding?.logoUrl).toBe('https://example.com/logo.png');
    expect(entity.branding?.paymentInstructions).toBe('Pay please');
    expect(entity.bankDetails?.iban).toBe('DE89 3704 0044 0532 0130 00');
  });

  it('treats blank text as missing', () => {
    expect(withSampleContent({ name: ' ', branding: { termsAndConditions: '  ' } }, samples).branding?.termsAndConditions).toBe('Terms');
  });

  it('uses routing and account numbers for a US company', () => {
    const entity = withSampleContent({ name: 'Acme', jurisdictionCode: 'us' }, samples);
    expect(entity.bankDetails?.routingNumber).toBeTruthy();
    expect(entity.bankDetails?.iban).toBeUndefined();
  });
});
