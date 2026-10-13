import { describe, expect, it } from 'vitest';
import {
  fingerprintTemplate,
  hammingDistance,
  isSameTemplate,
  normalizeForFingerprint,
  personalTokensFor,
  stripQuotedAndSignature,
} from './fingerprint';

const template = (name: string, company: string) =>
  `Hi ${name},\n\nI came across ${company} and noticed you are hiring sales people. We help companies like ${company} ` +
  `book more qualified meetings without adding headcount. Would you be open to a 15 minute call next Tuesday? ` +
  `You can pick a time here: https://cal.example/${name.toLowerCase()}\n\nBest,\nTom\n-- \nTom Jansen | Growthly | +31 6 1234 5678`;

describe('outbound fingerprint', () => {
  it('matches merge-field variants of one template', () => {
    const a = fingerprintTemplate({
      subject: 'Quick question for Acme',
      text: template('Anna', 'Acme'),
      personalTokens: personalTokensFor(['anna@acme.com'], ['Anna']),
    });
    const b = fingerprintTemplate({
      subject: 'Quick question for Bolt',
      text: template('Bram', 'Bolt'),
      personalTokens: personalTokensFor(['bram.dijk@bolt.io'], ['Bram']),
    });
    expect(a.tooShort).toBe(false);
    expect(isSameTemplate(a.fingerprint, b.fingerprint)).toBe(true);
  });

  it('keeps unrelated mails apart', () => {
    const a = fingerprintTemplate({ subject: 'Quick question', text: template('Anna', 'Acme') });
    const b = fingerprintTemplate({
      subject: 'Invoice 2026-114',
      text:
        'Hello Maria, attached is the invoice for the September maintenance visit. The amount is due within thirty days; ' +
        'let me know if the purchase order number on it needs to change before your finance team books it.',
    });
    expect(hammingDistance(a.fingerprint, b.fingerprint)).toBeGreaterThan(10);
  });

  it('ignores quoted history and the signature', () => {
    const text = 'Thanks, that works for us.\n\nOn Mon, 6 Oct 2026, Anna wrote:\n> Can we move the call?\n';
    expect(stripQuotedAndSignature(text).trim()).toBe('Thanks, that works for us.');
    expect(stripQuotedAndSignature('Body\n-- \nSignature line').trim()).toBe('Body');
  });

  it('replaces addresses, links and numbers with tokens', () => {
    expect(normalizeForFingerprint({ text: 'Mail me at a@b.com or see https://x.io/1 by 12-10' })).toBe(
      'mail me at tokemail or see tokurl by toknum',
    );
  });

  it('marks short replies as too short to track', () => {
    expect(fingerprintTemplate({ text: 'Thanks, see you then!' }).tooShort).toBe(true);
  });

  it('treats malformed fingerprints as far apart', () => {
    expect(hammingDistance('zz', '0000000000000000')).toBe(64);
  });
});
