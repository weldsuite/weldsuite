import { afterEach, describe, expect, it } from 'vitest';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { NO_JURISDICTION_FEATURES, type JurisdictionFeatures } from './jurisdiction';
import { isWeldbooksHrefVisible, WELDBOOKS_ANNUAL_REPORTS_HREF } from './jurisdiction-menu';

const nl: JurisdictionFeatures = { ...NO_JURISDICTION_FEATURES, vatReturn: true, icp: true };
const us: JurisdictionFeatures = { ...NO_JURISDICTION_FEATURES, salesTax: true };

afterEach(() => setRuntimeConfig(null));

describe('annual reports menu entry', () => {
  it('is hidden on Global, where the feature is Rust-only', () => {
    expect(isWeldbooksHrefVisible(WELDBOOKS_ANNUAL_REPORTS_HREF, { known: true, features: nl })).toBe(false);
  });

  it('is shown for a Dutch entity on an install that has it', () => {
    setRuntimeConfig({ backend: 'rust', unavailableFeatures: [] });
    expect(isWeldbooksHrefVisible(WELDBOOKS_ANNUAL_REPORTS_HREF, { known: true, features: nl })).toBe(true);
  });

  it('is hidden for other countries and until the jurisdiction is known', () => {
    setRuntimeConfig({ backend: 'rust', unavailableFeatures: [] });
    expect(isWeldbooksHrefVisible(WELDBOOKS_ANNUAL_REPORTS_HREF, { known: true, features: us })).toBe(false);
    expect(isWeldbooksHrefVisible(WELDBOOKS_ANNUAL_REPORTS_HREF, { known: false, features: nl })).toBe(false);
  });

  it('is hidden when the install lacks the annual reports', () => {
    setRuntimeConfig({ backend: 'rust', unavailableFeatures: ['annual-reports'] });
    expect(isWeldbooksHrefVisible(WELDBOOKS_ANNUAL_REPORTS_HREF, { known: true, features: nl })).toBe(false);
  });
});
