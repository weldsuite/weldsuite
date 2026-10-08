import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { isAppBeta } from '@/lib/apps/app-registry';
import { BetaBadge, RailBetaBadge } from './beta-badge';

describe('isAppBeta', () => {
  it('flags WeldConnect, also under its legacy aliases', () => {
    expect(isAppBeta('weldconnect')).toBe(true);
    expect(isAppBeta('connect')).toBe(true);
  });

  it('leaves other apps unflagged', () => {
    expect(isAppBeta('weldcrm')).toBe(false);
    expect(isAppBeta('not-an-app')).toBe(false);
  });
});

describe('BetaBadge', () => {
  it('renders the localized label inline', () => {
    render(
      <I18nProvider initialLanguage="en">
        <BetaBadge />
      </I18nProvider>,
    );
    expect(screen.getByTestId('beta-badge')).toHaveTextContent('BETA');
  });

  it('renders the localized label on the app rail', () => {
    render(
      <I18nProvider initialLanguage="nl">
        <RailBetaBadge />
      </I18nProvider>,
    );
    expect(screen.getByTestId('rail-beta-badge')).toHaveTextContent('BETA');
  });
});
