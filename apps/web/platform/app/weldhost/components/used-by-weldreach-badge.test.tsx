import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { UsedByWeldReachBadge } from './used-by-weldreach-badge';

const locale = vi.hoisted(() => ({ current: 'en' as 'en' | 'nl' }));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: locale.current === 'nl' ? dutch : english }) };
});

describe('UsedByWeldReachBadge', () => {
  it('says "Used by WeldReach" and explains what it blocks', () => {
    locale.current = 'en';
    render(<UsedByWeldReachBadge />);

    const badge = screen.getByTestId('used-by-weldreach-badge');
    expect(badge).toHaveTextContent(en.host.weldReach.usedByBadge);
    expect(badge).toHaveAttribute('title', en.host.weldReach.usedByHint);
  });

  it('reads in Dutch', () => {
    locale.current = 'nl';
    render(<UsedByWeldReachBadge />);

    expect(screen.getByTestId('used-by-weldreach-badge')).toHaveTextContent(nl.host.weldReach.usedByBadge);
    expect(nl.host.weldReach.usedByBadge).not.toBe(en.host.weldReach.usedByBadge);
  });
});

describe('host.weldReach strings', () => {
  it('exist in both languages with the same keys', () => {
    expect(Object.keys(nl.host.weldReach).sort()).toEqual(Object.keys(en.host.weldReach).sort());
    for (const value of Object.values(nl.host.weldReach)) expect(value.length).toBeGreaterThan(0);
  });
});
