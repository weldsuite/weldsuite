import { describe, expect, it } from 'vitest';
import { cachedWeldmailInstalled, canRenderMailGate } from './mail-gate';

describe('canRenderMailGate', () => {
  it('renders immediately on a cached "installed" answer while the live check is still loading', () => {
    expect(canRenderMailGate({ isLoading: true, isInstalled: true }, true)).toBe(true);
  });

  it('keeps the loader while loading with no cached "installed" answer', () => {
    expect(canRenderMailGate({ isLoading: true, isInstalled: true }, false)).toBe(false);
  });

  it('lets the live result override a cached "installed" answer once it resolves', () => {
    // Revoked since the cached answer was written.
    expect(canRenderMailGate({ isLoading: false, isInstalled: false }, true)).toBe(false);
  });

  it('shows mail once the live check confirms it, regardless of what was cached', () => {
    expect(canRenderMailGate({ isLoading: false, isInstalled: true }, false)).toBe(true);
  });
});

describe('cachedWeldmailInstalled', () => {
  it('is false with no cached list', () => {
    expect(cachedWeldmailInstalled(undefined)).toBe(false);
  });

  it('is false when weldmail is absent from the cached list', () => {
    expect(cachedWeldmailInstalled([{ appCode: 'weldcrm', status: 'active' }])).toBe(false);
  });

  it('is false when weldmail is cached but not active', () => {
    expect(cachedWeldmailInstalled([{ appCode: 'weldmail', status: 'inactive' }])).toBe(false);
  });

  it('is true when weldmail is cached and active, case-insensitively', () => {
    expect(cachedWeldmailInstalled([{ appCode: 'WeldMail', status: 'active' }])).toBe(true);
  });
});
