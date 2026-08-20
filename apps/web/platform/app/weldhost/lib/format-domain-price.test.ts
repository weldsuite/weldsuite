import { describe, expect, it } from 'vitest';
import { formatDomainPrice } from './format-domain-price';

describe('formatDomainPrice', () => {
  it('formats cents as USD when currency is missing', () => {
    const label = formatDomainPrice(1046, null, 'en-US');
    expect(label).toContain('10.46');
    expect(label).toMatch(/\$|USD/);
  });

  it('uses the currency from the catalog row', () => {
    const label = formatDomainPrice(1046, 'USD', 'en-US');
    expect(label).toContain('10.46');
    expect(label).toMatch(/\$|USD/);
  });

  it('returns null when there is no price', () => {
    expect(formatDomainPrice(null, 'USD', 'en-US')).toBeNull();
  });
});
