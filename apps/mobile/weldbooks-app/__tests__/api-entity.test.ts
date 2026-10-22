/**
 * Editing the company: how the app reads the fields an invoice needs off an
 * entity, and what it sends to `PATCH /accounting-entities/:id`.
 */

import api, { toEntity } from '@/services/api';

// See api.test.ts: a plain require yields the very client instance services/api.ts captured.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub = require('@weldsuite/api-client/client') as {
  __client: Record<string, jest.Mock>;
  __resetClient: () => void;
};
const client = stub.__client;

beforeEach(() => stub.__resetClient());

describe('toEntity', () => {
  it('reads the tax IDs, bank details and fiscal year an invoice needs', () => {
    const entity = toEntity({
      id: 'ent_1',
      name: 'E2E Company BV',
      jurisdictionCode: 'NL',
      taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '12345678' },
      bankDetails: { iban: 'NL91ABNA0417164300', bic: ' ' },
      fiscalYearStart: 4,
    });
    expect(entity).toMatchObject({
      vatNumber: 'NL123456789B01',
      registrationNumber: '12345678',
      iban: 'NL91ABNA0417164300',
      fiscalYearStart: 4,
    });
    expect(entity.bic).toBeUndefined();
  });

  it('leaves them empty on a company that has none yet', () => {
    const entity = toEntity({ id: 'ent_1', name: 'New', jurisdictionCode: 'NL' });
    expect(entity.vatNumber).toBeUndefined();
    expect(entity.iban).toBeUndefined();
    expect(entity.fiscalYearStart).toBeUndefined();
  });
});

describe('updateEntity', () => {
  it('merges the IBAN into the stored bank details, because the PATCH replaces them as a whole', async () => {
    client.get.mockResolvedValue({
      data: { id: 'ent_1', bankDetails: { bankName: 'ABN AMRO', accountNumber: '123' } },
    });
    client.patch.mockResolvedValue({ data: { id: 'ent_1', name: 'Co', jurisdictionCode: 'NL' } });

    await api.updateEntity('ent_1', {
      taxIdentifiers: { vatNumber: 'NL123456789B01' },
      bankDetails: { iban: 'NL91ABNA0417164300' },
    });

    expect(client.patch).toHaveBeenCalledWith('/accounting-entities/ent_1', {
      taxIdentifiers: { vatNumber: 'NL123456789B01' },
      bankDetails: { bankName: 'ABN AMRO', accountNumber: '123', iban: 'NL91ABNA0417164300' },
    });
  });

  it('removes a bank detail that was emptied', async () => {
    client.get.mockResolvedValue({ data: { id: 'ent_1', bankDetails: { iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' } } });
    client.patch.mockResolvedValue({ data: { id: 'ent_1', name: 'Co', jurisdictionCode: 'NL' } });

    await api.updateEntity('ent_1', { bankDetails: { bic: '' } });

    expect(client.patch).toHaveBeenCalledWith('/accounting-entities/ent_1', {
      bankDetails: { iban: 'NL91ABNA0417164300' },
    });
  });

  it('does not read the entity first when no bank details change', async () => {
    client.patch.mockResolvedValue({ data: { id: 'ent_1', name: 'New name', jurisdictionCode: 'NL' } });

    const entity = await api.updateEntity('ent_1', { name: 'New name', address: { country: 'NL', line1: 'Damrak 1' } });

    expect(client.get).not.toHaveBeenCalled();
    expect(client.patch).toHaveBeenCalledWith('/accounting-entities/ent_1', {
      name: 'New name',
      address: { country: 'NL', line1: 'Damrak 1' },
    });
    expect(entity.name).toBe('New name');
  });
});

describe('createEntity', () => {
  it('sends the KvK number and IBAN of a new company', async () => {
    client.post.mockResolvedValue({ data: { id: 'ent_1', name: 'Co', jurisdictionCode: 'NL' } });

    await api.createEntity({
      name: 'Co',
      jurisdictionCode: 'NL',
      vatNumber: 'NL123456789B01',
      registrationNumber: '12345678',
      iban: 'NL91ABNA0417164300',
      address: { country: 'NL', line1: 'Damrak 1', city: 'Amsterdam' },
    });

    expect(client.post).toHaveBeenCalledWith(
      '/accounting-entities',
      expect.objectContaining({
        vatNumber: 'NL123456789B01',
        taxIdentifiers: { registrationNumber: '12345678' },
        bankDetails: { iban: 'NL91ABNA0417164300' },
        address: { country: 'NL', line1: 'Damrak 1', city: 'Amsterdam' },
        seedDefaults: true,
      }),
    );
  });
});
