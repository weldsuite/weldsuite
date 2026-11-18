import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountingEntity } from '@/lib/api/domains/weldbooks';
import type { PostalAddress } from '@/components/address/postal-address';

const env = vi.hoisted(() => ({
  canUpdate: true,
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canUpdate }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useUpdateAccountingEntity: () => ({ mutateAsync: env.update, isPending: false }),
}));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('./test-utils');
  return { Link: HrefLink };
});
// The street field is a Mapbox autocomplete; a plain street and city stand in for the address form.
vi.mock('@/components/address/address-fields', () => ({
  AddressFields: ({ value, onChange }: Readonly<{ value: PostalAddress; onChange: (next: PostalAddress) => void }>) => (
    <>
      <label htmlFor="street">Street</label>
      <input id="street" value={value.line1 ?? ''} onChange={(e) => onChange({ ...value, line1: e.target.value })} />
      <label htmlFor="city">City</label>
      <input id="city" value={value.city ?? ''} onChange={(e) => onChange({ ...value, city: e.target.value })} />
    </>
  ),
}));

import { EntityInvoiceDetailsNotice } from './entity-invoice-details';
import { renderWithProviders } from './test-utils';

const LABELS = {
  vatNumber: 'VAT number',
  registrationNumber: 'KvK number',
  iban: 'IBAN',
  bic: 'BIC',
  address: 'Business address',
};

function entity(overrides: Partial<AccountingEntity> = {}): AccountingEntity {
  return {
    id: 'ent_1',
    name: 'Acme',
    legalName: 'Acme B.V.',
    jurisdictionCode: 'NL',
    baseCurrency: 'EUR',
    bankDetails: { bankName: 'ING', accountNumber: '123' },
    ...overrides,
  } as AccountingEntity;
}

function renderNotice(missing: Array<keyof typeof LABELS>, row: AccountingEntity | null = entity()) {
  return renderWithProviders(
    <EntityInvoiceDetailsNotice entity={row ?? undefined} missing={missing} labels={LABELS} context="create" />,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Add business details' }));
  return screen.findByRole('dialog');
}

describe('EntityInvoiceDetailsNotice', () => {
  beforeEach(() => {
    env.canUpdate = true;
    env.update.mockReset().mockResolvedValue({ data: entity() });
    env.toast.success.mockReset();
    env.toast.error.mockReset();
  });

  it('renders nothing when the entity has every detail, or has not loaded', () => {
    renderNotice([]);
    renderNotice(['iban'], null);
    expect(screen.queryByTestId('entity-invoice-details-notice')).not.toBeInTheDocument();
  });

  it('names the missing details, and asks for someone who can edit them without the permission', () => {
    env.canUpdate = false;
    renderNotice(['vatNumber', 'address']);
    const notice = screen.getByTestId('entity-invoice-details-notice');
    expect(notice).toHaveTextContent('Every invoice must show your VAT number, Business address.');
    expect(notice).toHaveTextContent('Ask someone who can edit the company settings to add them.');
    expect(screen.queryByRole('button', { name: 'Add business details' })).not.toBeInTheDocument();
  });

  it('asks only for the missing fields and refuses to save them empty or with a bad IBAN', async () => {
    const user = userEvent.setup();
    renderNotice(['vatNumber', 'iban', 'address']);
    const dialog = await openDialog(user);

    expect(within(dialog).queryByLabelText('KvK number')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('BIC')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Acme B.V. prints these on every invoice.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Save details' }));
    expect(within(dialog).getAllByText('Required')).toHaveLength(2);
    expect(within(dialog).getByText('Enter at least a street and a city')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('IBAN'), 'NL00 BANK 1234');
    expect(within(dialog).getByText(/Not a valid IBAN/)).toBeInTheDocument();
    expect(env.update).not.toHaveBeenCalled();
  });

  it('refuses a KvK number that is not 8 digits for an NL entity, inline instead of in a toast', async () => {
    const user = userEvent.setup();
    renderNotice(['registrationNumber']);
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText('KvK number'), '123');
    await user.click(within(dialog).getByRole('button', { name: 'Save details' }));
    expect(within(dialog).getByText('A KvK number has 8 digits')).toBeInTheDocument();
    expect(env.update).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText('KvK number'));
    await user.type(within(dialog).getByLabelText('KvK number'), '1234 5678');
    expect(within(dialog).queryByText('A KvK number has 8 digits')).not.toBeInTheDocument();
  });

  it('saves the details on the entity, keeping the bank details it has', async () => {
    const user = userEvent.setup();
    renderNotice(['vatNumber', 'registrationNumber', 'iban', 'bic', 'address']);
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText('VAT number'), ' NL123456789B01 ');
    await user.type(within(dialog).getByLabelText('KvK number'), '12345678');
    await user.type(within(dialog).getByLabelText('IBAN'), 'nl91 abna 0417 1643 00');
    await user.type(within(dialog).getByLabelText('BIC'), 'abnanl2a');
    await user.type(within(dialog).getByLabelText('Street'), 'Hoofdweg 76');
    await user.type(within(dialog).getByLabelText('City'), 'Ede');
    await user.click(within(dialog).getByRole('button', { name: 'Save details' }));

    await waitFor(() => expect(env.update).toHaveBeenCalledTimes(1));
    expect(env.update).toHaveBeenCalledWith({
      id: 'ent_1',
      data: {
        taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '12345678' },
        bankDetails: { bankName: 'ING', accountNumber: '123', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' },
        // The country comes from the jurisdiction.
        address: { line1: 'Hoofdweg 76', city: 'Ede', country: 'NL' },
      },
    });
    expect(env.toast.success).toHaveBeenCalledWith('Business details saved');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog open and says why when the server refuses a value', async () => {
    const user = userEvent.setup();
    env.update.mockRejectedValue(new Error('Invalid BTW number'));
    renderNotice(['vatNumber']);
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText('VAT number'), 'NL1');
    await user.click(within(dialog).getByRole('button', { name: 'Save details' }));

    await waitFor(() =>
      expect(env.toast.error).toHaveBeenCalledWith('Could not save the business details', {
        description: 'Invalid BTW number',
      }),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
