import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({ push: vi.fn(), post: vi.fn() }));

vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ setEntityId: vi.fn() }) }));
vi.mock('@/lib/api/weldbooks-client', () => ({
  weldbooksApi: {
    get: async () => ({
      data: [
        { code: 'NL', name: 'Netherlands', defaultLocale: 'nl-NL', defaultCurrency: 'EUR' },
        { code: 'IN', name: 'India', defaultLocale: 'en-IN', defaultCurrency: 'INR' },
        { code: 'US', name: 'United States', defaultLocale: 'en-US', defaultCurrency: 'USD' },
      ],
    }),
    post: env.post,
  },
}));

import { CreateEntityDialog } from './create-entity-dialog';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

async function chooseJurisdiction(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getAllByRole('combobox')[0]);
  await user.click(await screen.findByRole('option', { name }));
}

describe('CreateEntityDialog', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.push.mockReset();
    env.post.mockReset().mockResolvedValue({ data: { id: 'ent_new' } });
  });

  it('sends a US entity to the setup guide instead of creating one without a legal form', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(<CreateEntityDialog open onOpenChange={onOpenChange} />);

    await chooseJurisdiction(user, /United States/);

    expect(screen.getByTestId('us-setup-notice')).toHaveTextContent('Set up a US entity');
    expect(screen.queryByLabelText(/Name/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start US setup' }));

    expect(env.push).toHaveBeenCalledWith('/settings/entities/add');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(env.post).not.toHaveBeenCalled();
  });

  it('still creates a Dutch entity right here, with its business address', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateEntityDialog open onOpenChange={vi.fn()} />);

    expect(screen.queryByTestId('us-setup-notice')).not.toBeInTheDocument();
    await user.type(await screen.findByLabelText(/Name/), 'WeldCorp BV');

    // The address is asked for, and the entity is not created without a street and city.
    expect(screen.getByTestId('entity-address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Create/ })).toBeDisabled();
    await user.type(screen.getByLabelText('Address line 1'), 'Damrak 1');
    await user.type(screen.getByLabelText('Postal code'), '1012 LG');
    await user.type(screen.getByLabelText('City'), 'Amsterdam');
    await user.click(screen.getByRole('button', { name: /^Create/ }));

    await waitFor(() => expect(env.post).toHaveBeenCalledTimes(1));
    expect(env.post.mock.calls[0][0]).toBe('/accounting-entities');
    expect(env.post.mock.calls[0][1]).toMatchObject({
      name: 'WeldCorp BV',
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
      address: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' },
    });
  });

  it('asks an Indian entity for its address with a GST state picker', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateEntityDialog open onOpenChange={vi.fn()} />);

    await chooseJurisdiction(user, /India/);
    await user.type(await screen.findByLabelText(/Name/), 'WeldCorp Pvt Ltd');
    await user.type(screen.getByLabelText('Address line 1'), '12 Linking Road');
    await user.type(screen.getByLabelText('City'), 'Mumbai');

    // The state is a picker of the GST states (with their GST codes), not free text.
    await user.click(screen.getByRole('combobox', { name: 'State / province' }));
    await user.click(await screen.findByRole('option', { name: 'Maharashtra (27)' }));
    await user.click(screen.getByRole('button', { name: /^Create/ }));

    await waitFor(() => expect(env.post).toHaveBeenCalledTimes(1));
    expect(env.post.mock.calls[0][1]).toMatchObject({
      jurisdictionCode: 'IN',
      address: { line1: '12 Linking Road', city: 'Mumbai', state: 'Maharashtra', country: 'IN' },
    });
  });
});
