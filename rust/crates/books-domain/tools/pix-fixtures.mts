/**
 * Pix BR Codes and their QR modules as TypeScript builds them
 * (`@weldsuite/books-domain/jurisdictions/br/pix`, uqr), for the Rust test in
 * `src/jurisdictions/br/pix.rs`. Regenerate after changing pix.ts or uqr:
 *
 *   pnpm --filter @weldsuite/books-domain exec tsx ../../../rust/crates/books-domain/tools/pix-fixtures.mts
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPixPayload, pixQrMatrix, pixQrSvg, type PixPayloadInput } from '../../../../packages/domains/books/src/jurisdictions/br/pix';

const here = path.dirname(fileURLToPath(import.meta.url));

const cases: PixPayloadInput[] = [
  { key: '12345678000195', merchantName: 'Empresa Teste Ltda', merchantCity: 'São Paulo', amount: 1234.5, txid: 'INV-0001' },
  {
    key: 'financeiro@empresa.com.br',
    merchantName: 'Açúcar & Café Comércio',
    merchantCity: 'Florianópolis',
    amount: 99.99,
    txid: 'NF 2026/42',
    description: 'Fatura de serviços',
  },
  { key: '+5511987654321', merchantName: '', merchantCity: '', txid: '' },
  { key: '123e4567-e89b-12d3-a456-426614174000', merchantName: 'X', merchantCity: 'Rio', amount: 0.01, txid: 'inv_abcdefghijklmnopqrstuvwxyz0123' },
];

const lines = cases.map((input) => {
  const payload = buildPixPayload(input);
  const rows = pixQrMatrix(payload).map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
  return JSON.stringify({ input, payload, rows, svgLength: pixQrSvg(payload, 140).length });
});
writeFileSync(path.join(here, '..', 'tests', 'fixtures', 'pix.jsonl'), `${lines.join('\n')}\n`);
