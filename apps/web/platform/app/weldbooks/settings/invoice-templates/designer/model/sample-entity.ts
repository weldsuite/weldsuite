/**
 * The company a template is previewed with: the real entity, with sample text
 * filled in where it has none, so a block that would print nothing still
 * shows what it looks like.
 */
import type { InvoicePdfEntity } from '@/lib/weldbooks/invoice-pdf';

export interface SampleTexts {
  entityName: string;
  footerText: string;
  paymentInstructions: string;
  terms: string;
  bankName: string;
}

type EntityLike = Partial<InvoicePdfEntity> & { id?: string };

const has = (value: string | null | undefined) => Boolean(value && value.trim());

export function withSampleContent<T extends EntityLike>(entity: T | undefined, samples: SampleTexts): InvoicePdfEntity {
  const base: EntityLike = entity ?? {};
  const branding = base.branding ?? {};
  const bank = base.bankDetails;
  const hasBank = Boolean(bank && (has(bank.iban) || has(bank.accountNumber)));
  const code = base.jurisdictionCode?.toUpperCase();
  const northAmerica = code === 'US' || code === 'CA';
  return {
    ...base,
    name: base.name && has(base.name) ? base.name : samples.entityName,
    branding: {
      ...branding,
      footerText: has(branding.footerText) ? branding.footerText : samples.footerText,
      paymentInstructions: has(branding.paymentInstructions) ? branding.paymentInstructions : samples.paymentInstructions,
      termsAndConditions: has(branding.termsAndConditions) ? branding.termsAndConditions : samples.terms,
    },
    bankDetails: hasBank
      ? bank
      : northAmerica
        ? { bankName: samples.bankName, routingNumber: '021000021', accountNumber: '000123456789' }
        : { bankName: samples.bankName, iban: 'NL91 ABNA 0417 1643 00', bic: 'ABNANL2A' },
  };
}
