/**
 * Pix static BR Code (EMV Merchant-Presented QR, "Manual de Padrões para
 * Iniciação do Pix", BACEN). The payload is a string of ID + 2-digit length +
 * value fields, closed by a CRC16/CCITT-FALSE checksum over everything before
 * it (including "6304"). Any bank app can scan it, or paste it as "Pix copia e
 * cola", to pay the amount to the key.
 *
 * This is the platform's copy of `packages/domains/books/src/jurisdictions/br/pix.ts`
 * (the SPA does not depend on the domain package): keep the two in sync.
 */
import { encode } from 'uqr';

function field(id: string, value: string): string {
  if (value.length > 99) throw new Error(`Pix field ${id} is longer than 99 characters`);
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** Upper-case ASCII without accents: names and cities are limited to the EMV basic character set. */
function plain(value: string, max: number): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,\-/]/g, '')
    .trim()
    .slice(0, max);
}

/** CRC16/CCITT-FALSE: polynomial 0x1021, initial 0xFFFF, no reflection, no final XOR. */
export function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export interface PixPayloadInput {
  /** Pix key: CNPJ/CPF digits, e-mail, +55 phone, or random key (EVP). */
  key: string;
  /** Receiver name, up to 25 characters. */
  merchantName: string;
  /** Receiver city, up to 15 characters. */
  merchantCity: string;
  /** Amount in BRL; omit for an open amount. */
  amount?: number;
  /** Reference shown to the payer and returned in the statement: up to 25 letters/digits, else "***". */
  txid?: string;
  /** Free text for the payer, kept short so the account field stays within 99 characters. */
  description?: string;
}

export function buildPixPayload(input: PixPayloadInput): string {
  const key = input.key.trim();
  if (!key) throw new Error('A Pix key is required');
  let account = field('00', 'br.gov.bcb.pix') + field('01', key);
  const description = input.description ? plain(input.description, 72 - key.length) : '';
  if (description) account += field('02', description);

  const txid = (input.txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  let payload =
    field('00', '01') +
    field('26', account) +
    field('52', '0000') +
    field('53', '986') +
    (input.amount !== undefined && input.amount > 0 ? field('54', input.amount.toFixed(2)) : '') +
    field('58', 'BR') +
    field('59', plain(input.merchantName, 25) || 'N/A') +
    field('60', plain(input.merchantCity, 15) || 'BRASIL') +
    field('62', field('05', txid));
  payload += '6304';
  return payload + crc16Ccitt(payload);
}

/**
 * name@domain.tld: exactly one "@", both sides non-empty and without whitespace,
 * and a "." inside the domain (not its first or last character). Checked without
 * a regex: the equivalent pattern backtracks super-linearly.
 */
function isPlausibleEmail(k: string): boolean {
  const parts = k.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain || /\s/.test(local) || /\s/.test(domain)) return false;
  return domain.slice(1, -1).includes('.');
}

/** Basic check of a Pix key's shape (it does not check that the key is registered). */
export function isPlausiblePixKey(key: string): boolean {
  const k = key.trim();
  if (/^\d{11}$/.test(k) || /^[0-9A-Z]{12}\d{2}$/.test(k)) return true; // CPF / CNPJ
  if (/^\+55\d{10,11}$/.test(k)) return true; // phone
  if (isPlausibleEmail(k) && k.length <= 77) return true; // e-mail
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k); // random key
}

/** The QR modules of a payload (true = dark), quiet zone included; error correction M as the BACEN manual recommends. */
export function pixQrMatrix(payload: string): boolean[][] {
  return encode(payload, { ecc: 'M', border: 2 }).data;
}
