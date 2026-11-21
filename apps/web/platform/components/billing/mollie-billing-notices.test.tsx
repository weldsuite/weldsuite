import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { en } from '@weldsuite/i18n/locales/en';
import { MollieBillingNotices } from './mollie-billing-notices';

const ts = en.settings.billing.mollie;
const outstanding = {
  amount: 12100,
  currency: 'EUR',
  payUrl: 'https://app.weldsuite.eu/public/billing/pay/tok',
  since: '2027-01-14T10:30:00Z',
};
const scheduledChange = {
  planId: 'plan_team',
  planName: 'Team',
  seats: 3,
  cycle: 'yearly' as const,
  effectiveAt: '2027-02-14T10:00:00Z',
};

describe('MollieBillingNotices', () => {
  it('shows nothing without a past-due charge or a scheduled change (Stripe)', () => {
    const { container } = render(<MollieBillingNotices canPay />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the past-due charge with a link to pay it', () => {
    render(<MollieBillingNotices outstanding={outstanding} canPay />);
    expect(screen.getByText(ts.pastDueTitle)).toBeInTheDocument();
    expect(screen.getByText(/€121\.00/)).toBeInTheDocument();
    expect(screen.getByText(/14th Jan 2027/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: ts.payNow })).toHaveAttribute('href', outstanding.payUrl);
  });

  it('leaves the pay link out for a viewer who may not pay', () => {
    render(<MollieBillingNotices outstanding={outstanding} canPay={false} />);
    expect(screen.getByText(ts.pastDueTitle)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: ts.payNow })).not.toBeInTheDocument();
  });

  it('says what changes at the period end', () => {
    render(<MollieBillingNotices scheduledChange={scheduledChange} canPay />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Team');
    expect(text).toContain('14th Feb 2027');
    expect(text).toContain(ts.cycleYearly);
    render(<MollieBillingNotices scheduledChange={{ ...scheduledChange, cycle: 'monthly' }} canPay />);
    expect(document.body.textContent).toContain(ts.cycleMonthly);
  });
});
