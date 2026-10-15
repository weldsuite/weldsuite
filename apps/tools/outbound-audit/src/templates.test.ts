import { describe, expect, it } from 'vitest';
import { fingerprintTemplate, hammingDistance, personalTokensFor } from '@weldsuite/mail-domain/outbound/fingerprint';
import { TemplateClusterer } from './templates';
import { COLD_RECIPIENTS, coldBody } from './__fixtures__/rows';

/** Flip the given bit positions (0 = most significant) of a 16-hex-char fingerprint. */
function flipBits(fingerprint: string, bits: number[]): string {
  const value = BigInt(`0x${fingerprint}`);
  let flipped = value;
  for (const bit of bits) flipped ^= 1n << BigInt(63 - bit);
  return flipped.toString(16).padStart(16, '0');
}

describe('TemplateClusterer', () => {
  it('puts copies of one merge-field template in one cluster', () => {
    const clusterer = new TemplateClusterer();
    const indexes = COLD_RECIPIENTS.slice(0, 5).map((r) => {
      const fp = fingerprintTemplate({
        subject: `Quick question for ${r.company}`,
        text: coldBody(r.first, r.company),
        personalTokens: personalTokensFor([r.email], [r.name]),
      });
      return clusterer.assign(fp.fingerprint);
    });
    expect(new Set(indexes).size).toBe(1);
    expect(clusterer.size).toBe(1);
  });

  it('matches near-duplicates whose differing bits fall in every band', () => {
    const clusterer = new TemplateClusterer();
    const base = '0123456789abcdef';
    expect(clusterer.assign(base)).toBe(0);
    // Three flipped bits in three different 16-bit bands: one band still agrees.
    const near = flipBits(base, [1, 20, 40]);
    expect(hammingDistance(base, near)).toBe(3);
    expect(clusterer.assign(near)).toBe(0);
    // Four flipped bits: beyond FINGERPRINT_MAX_DISTANCE, a new template.
    const far = flipBits(base, [1, 20, 40, 60]);
    expect(clusterer.assign(far)).toBe(1);
    expect(clusterer.representative(1)).toBe(far);
  });

  it('keeps unrelated mails apart', () => {
    const clusterer = new TemplateClusterer();
    const a = fingerprintTemplate({
      subject: 'Invoice for September',
      text: 'Please find attached the invoice for September. Payment is due within thirty days of the invoice date, thank you.',
    });
    const b = fingerprintTemplate({
      subject: 'Team offsite',
      text: 'The team offsite is moving to the second week of November because the venue double booked the conference room.',
    });
    expect(clusterer.assign(a.fingerprint)).not.toBe(clusterer.assign(b.fingerprint));
  });
});
