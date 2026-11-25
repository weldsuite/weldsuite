import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ShippingErrorNotice } from './shipping-error-notice';

const t = en.weldstash.shipping.errors;

describe('ShippingErrorNotice', () => {
  it('shows the title, the translated code and the carrier reasons', () => {
    const error = new ApiError('raw', 422, {
      error: { code: 'SHIPMENT_INVALID', message: 'raw', details: { messages: ['Postal code is wrong', 'Weight too high'] } },
    });
    renderWithProviders(<ShippingErrorNotice error={error} title="Labels failed" />);
    expect(screen.getByText('Labels failed')).toBeInTheDocument();
    expect(screen.getByText(t.SHIPMENT_INVALID)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Postal code is wrong', 'Weight too high']);
  });

  it('falls back to the generic line and shows no list without reasons', () => {
    renderWithProviders(<ShippingErrorNotice error="boom" title="Labels failed" />);
    expect(screen.getByText(t.generic)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows the credit top-up notice for a 402', () => {
    const error = new ApiError('Payment required', 402, { error: { details: {} } });
    renderWithProviders(<ShippingErrorNotice error={error} title="Labels failed" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Labels failed')).not.toBeInTheDocument();
  });
});
