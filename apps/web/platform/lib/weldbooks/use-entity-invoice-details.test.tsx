import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';

const env = vi.hoisted(() => ({
  entity: undefined as unknown,
  loading: false,
  jurisdictions: undefined as unknown,
}));

vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ entityId: 'ent_1' }) }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingEntity: () => ({ data: env.entity, isLoading: env.loading }),
  useAccountingJurisdictions: () => ({ data: env.jurisdictions }),
}));

import { useEntityInvoiceDetails } from './use-entity-invoice-details';

const NL = {
  code: 'NL',
  terminology: { tax: 'vat', taxId: 'vat_number', registrationId: 'kvk', supplier: 'supplier', creditNote: 'credit_note' },
  invoiceRequiredFields: ['vatNumber', 'registrationNumber', 'iban', 'address'],
};

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return <I18nProvider initialLanguage="en">{children}</I18nProvider>;
}

describe('useEntityInvoiceDetails', () => {
  beforeEach(() => {
    env.entity = undefined;
    env.loading = false;
    env.jurisdictions = [NL];
  });

  it('asks for nothing until the entity has loaded', () => {
    env.loading = true;
    const { result } = renderHook(() => useEntityInvoiceDetails(), { wrapper });
    expect(result.current.missing).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("lists what the entity lacks of its jurisdiction's invoice fields, in the jurisdiction's words", () => {
    env.entity = {
      id: 'ent_1',
      name: 'Acme',
      jurisdictionCode: 'nl',
      baseCurrency: 'EUR',
      taxIdentifiers: { registrationNumber: '12345678' },
      address: { line1: 'Hoofdweg 76', city: 'Ede' },
    };
    const { result } = renderHook(() => useEntityInvoiceDetails(), { wrapper });
    expect(result.current.missing).toEqual(['vatNumber', 'iban']);
    expect(result.current.labels).toEqual({
      vatNumber: 'VAT number',
      registrationNumber: 'Chamber of Commerce (KvK) number',
      iban: 'IBAN',
      bic: 'BIC / SWIFT',
      address: 'Business address',
    });
  });

  it('falls back to the built-in list and neutral wording before the jurisdictions load', () => {
    env.jurisdictions = undefined;
    env.entity = { id: 'ent_1', name: 'Acme', jurisdictionCode: 'NL', baseCurrency: 'EUR' };
    const { result } = renderHook(() => useEntityInvoiceDetails(), { wrapper });
    expect(result.current.missing).toEqual(['vatNumber', 'registrationNumber', 'iban', 'address']);
    expect(result.current.labels.registrationNumber).toBe('Company registration number');
  });
});
