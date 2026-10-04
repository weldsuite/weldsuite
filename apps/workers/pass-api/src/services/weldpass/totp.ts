/**
 * Time-based one-time passwords (RFC 6238) for logins that store a 2FA seed.
 *
 * Codes are generated here, on the server, rather than in the browser: a
 * teammate who needs the six digits never has to be sent the seed that mints
 * them. The seed only leaves the vault through an item reveal.
 */

type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';

export interface TotpConfig {
  secret: Uint8Array<ArrayBuffer>;
  digits: number;
  /** Seconds each code is valid for. */
  period: number;
  algorithm: TotpAlgorithm;
}

export class TotpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpError';
  }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(input: string): Uint8Array<ArrayBuffer> {
  // Authenticator apps show the secret in groups with spaces or dashes.
  const cleaned = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!cleaned) throw new TotpError('The two-factor secret is empty.');

  const bytes = new Uint8Array(new ArrayBuffer(Math.floor((cleaned.length * 5) / 8)));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of cleaned) {
    const value = BASE32.indexOf(char);
    if (value === -1) {
      throw new TotpError('The two-factor secret is not valid base32 (letters A–Z and digits 2–7).');
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  if (bytes.length === 0) throw new TotpError('The two-factor secret is too short.');
  return bytes;
}

const ALGORITHMS: Record<string, TotpAlgorithm> = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
};

/**
 * Accepts what a site hands out when enabling 2FA: either the bare base32
 * secret or the `otpauth://totp/…` URI encoded in the QR code.
 */
export function parseTotp(input: string): TotpConfig {
  const trimmed = input.trim();
  if (!/^otpauth:\/\//i.test(trimmed)) {
    return { secret: decodeBase32(trimmed), digits: 6, period: 30, algorithm: 'SHA-1' };
  }

  let uri: URL;
  try {
    uri = new URL(trimmed);
  } catch {
    throw new TotpError('The otpauth:// link could not be read.');
  }
  if (uri.hostname.toLowerCase() !== 'totp') {
    throw new TotpError('Only time-based (TOTP) two-factor codes are supported.');
  }

  const secret = uri.searchParams.get('secret');
  if (!secret) throw new TotpError('The otpauth:// link has no secret.');

  const digits = Number.parseInt(uri.searchParams.get('digits') ?? '6', 10);
  const period = Number.parseInt(uri.searchParams.get('period') ?? '30', 10);
  const algorithm = ALGORITHMS[(uri.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()];

  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new TotpError('Two-factor codes must be 6 to 8 digits long.');
  }
  if (!Number.isInteger(period) || period < 5 || period > 300) {
    throw new TotpError('The two-factor period is out of range.');
  }
  if (!algorithm) throw new TotpError('Unsupported two-factor algorithm.');

  return { secret: decodeBase32(secret), digits, period, algorithm };
}

export interface TotpCode {
  code: string;
  period: number;
  /** When this code stops being accepted. */
  expiresAt: Date;
}

export async function totpCode(config: TotpConfig, now: Date = new Date()): Promise<TotpCode> {
  const seconds = Math.floor(now.getTime() / 1000);
  const counter = Math.floor(seconds / config.period);

  // 8-byte big-endian counter. The high word is zero until the year 4000-ish
  // for a 30s period, but is written anyway rather than assumed.
  const message = new DataView(new ArrayBuffer(8));
  message.setUint32(0, Math.floor(counter / 2 ** 32));
  message.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw',
    config.secret,
    { name: 'HMAC', hash: config.algorithm },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message.buffer));

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return {
    code: (binary % 10 ** config.digits).toString().padStart(config.digits, '0'),
    period: config.period,
    expiresAt: new Date((counter + 1) * config.period * 1000),
  };
}
