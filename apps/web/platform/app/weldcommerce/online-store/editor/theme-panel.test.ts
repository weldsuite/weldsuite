import { describe, expect, it } from 'vitest';
import { defaultSiteDocument, type SiteDocument } from '@weldsuite/storefront-theme/catalog';
import { applyShopField } from './theme-panel';

function withSettings(settings: Partial<SiteDocument['settings']>): SiteDocument {
  const document = defaultSiteDocument();
  return { ...document, settings: { ...document.settings, ...settings } };
}

describe('applyShopField', () => {
  it('sets the WeldPanel key, keeping the other analytics settings, with analytics last', () => {
    const before = withSettings({ analytics: { collectorUrl: 'https://panel.example.com' } });
    const after = applyShopField(before, 'analyticsKey', '  wpk_1  ');
    expect(after.settings.analytics).toEqual({ collectorUrl: 'https://panel.example.com', weldpanelProjectKey: 'wpk_1' });
    expect(Object.keys(after.settings).at(-1)).toBe('analytics');
    expect(before.settings.analytics).toEqual({ collectorUrl: 'https://panel.example.com' });
  });

  it('drops analytics altogether once the key is emptied and nothing else is left', () => {
    const before = withSettings({ analytics: { weldpanelProjectKey: 'wpk_1' } });
    const after = applyShopField(before, 'analyticsKey', '');
    expect('analytics' in after.settings).toBe(false);
    expect(after.settings).toEqual({ access: before.settings.access, cookieBanner: before.settings.cookieBanner });
    expect(before.settings.analytics).toEqual({ weldpanelProjectKey: 'wpk_1' });
  });

  it('keeps the rest of the analytics when only the key is emptied', () => {
    const before = withSettings({ analytics: { weldpanelProjectKey: 'wpk_1', collectorUrl: 'https://panel.example.com' } });
    expect(applyShopField(before, 'analyticsKey', ' ').settings.analytics).toEqual({ collectorUrl: 'https://panel.example.com' });
  });
});
