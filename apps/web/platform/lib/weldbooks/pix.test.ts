import { describe, expect, it } from 'vitest';
import { buildPixPayload as domainPayload } from '../../../../../packages/domains/books/src/jurisdictions/br/pix';
import { buildPixPayload, crc16Ccitt, isPlausiblePixKey, pixQrMatrix } from './pix';

describe('Pix BR Code', () => {
  it('matches the BACEN manual example (key, no amount, txid "***")', () => {
    const payload = buildPixPayload({
      key: '123e4567-e12b-12d1-a456-426655440000',
      merchantName: 'Fulano de Tal',
      merchantCity: 'BRASILIA',
    });
    expect(payload.endsWith('63041D3D')).toBe(true);
    expect(payload).toContain('0014br.gov.bcb.pix');
    expect(payload).toContain('5802BR');
  });

  it('closes every payload with the CRC16 of what precedes it', () => {
    const payload = buildPixPayload({ key: '11222333000181', merchantName: 'WeldCorp Ltda', merchantCity: 'São Paulo', amount: 1234.5, txid: 'INV-2026-0001' });
    expect(payload).toContain('54071234.50');
    expect(payload.slice(-4)).toBe(crc16Ccitt(payload.slice(0, -4)));
    expect(payload).toContain('0511INV20260001');
  });

  it('gives the same payload as the books domain (the server HTML invoice)', () => {
    const input = { key: 'pix@weldcorp.com.br', merchantName: 'Weld Corp Ltda', merchantCity: 'Curitiba', amount: 99.9, txid: 'FT0042' };
    expect(buildPixPayload(input)).toBe(domainPayload(input));
  });

  it('refuses an empty key', () => {
    expect(() => buildPixPayload({ key: ' ', merchantName: 'A', merchantCity: 'B' })).toThrow();
  });

  it('recognises the shapes of a Pix key', () => {
    expect(isPlausiblePixKey('11222333000181')).toBe(true);
    expect(isPlausiblePixKey('+5511987654321')).toBe(true);
    expect(isPlausiblePixKey('a@b.com')).toBe(true);
    expect(isPlausiblePixKey('123e4567-e12b-12d1-a456-426655440000')).toBe(true);
    expect(isPlausiblePixKey('not a key')).toBe(false);
  });

  it('renders a square QR matrix with a quiet zone', () => {
    const matrix = pixQrMatrix(buildPixPayload({ key: 'a@b.com', merchantName: 'X', merchantCity: 'Y' }));
    expect(matrix.length).toBeGreaterThan(20);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    expect(matrix[0].every((dark) => !dark)).toBe(true);
  });
});
