import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { en } from '@weldsuite/i18n/locales/en';
import { BuyCreditsDialog } from './buy-credits-dialog';

const packages = [{ id: 'pkg_small', name: 'Small', credits: 1000, price: 10, currency: 'EUR', isPopular: true }];

describe('BuyCreditsDialog', () => {
  it('says the prices exclude VAT when plans are billed through Mollie', async () => {
    const onBuy = vi.fn();
    render(
      <BuyCreditsDialog
        open
        onOpenChange={vi.fn()}
        balance={40}
        packages={packages}
        pending={false}
        onBuy={onBuy}
        priceNote={en.settings.billing.mollie.excludingVat}
      />,
    );
    expect(screen.getByText(en.settings.billing.mollie.excludingVat)).toBeInTheDocument();
    expect(screen.getByText('€10.00')).toBeInTheDocument();
    // The package's own button (its credit count is formatted in the machine's locale).
    const pkg = screen.getByText('€10.00').closest('button');
    expect(pkg).not.toBeNull();
    await userEvent.click(pkg as HTMLButtonElement);
    expect(onBuy).toHaveBeenCalledWith('pkg_small');
  });

  it('has no note without one, and none without packages', () => {
    const { unmount } = render(
      <BuyCreditsDialog open onOpenChange={vi.fn()} balance={0} packages={packages} pending={false} onBuy={vi.fn()} />,
    );
    expect(screen.queryByText(en.settings.billing.mollie.excludingVat)).not.toBeInTheDocument();
    unmount();
    render(
      <BuyCreditsDialog
        open
        onOpenChange={vi.fn()}
        balance={0}
        packages={[]}
        pending={false}
        onBuy={vi.fn()}
        priceNote={en.settings.billing.mollie.excludingVat}
      />,
    );
    expect(screen.getByText(en.settings.billing.creditsWallet.noPackages)).toBeInTheDocument();
    expect(screen.queryByText(en.settings.billing.mollie.excludingVat)).not.toBeInTheDocument();
  });
});
