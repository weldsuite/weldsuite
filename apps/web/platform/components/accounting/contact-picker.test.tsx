import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

type Contact = { id: string; name: string; email?: string | null };

const env = vi.hoisted(() => ({
  /** Every contact the server has; the search answers with those matching what was typed. */
  contacts: [] as Array<{ id: string; name: string; email?: string | null }>,
  search: vi.fn(),
  /** The contact `useAccountingCustomer` finds by id, whatever the list holds. */
  byId: {} as Record<string, { id: string; name: string; email?: string | null }>,
}));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingContactSearch: () => env.search,
  useAccountingCustomer: (id: string) => ({ data: id && env.byId[id] ? { data: env.byId[id] } : undefined }),
}));

import { ContactPicker } from './contact-picker';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const tc = en.accounting.contacts;

function renderPicker(props: { value?: string; onChange?: (id: string) => void } = {}) {
  const onChange = props.onChange ?? vi.fn();
  renderWithProviders(
    <>
      <label htmlFor="contactId">Customer</label>
      <ContactPicker
        id="contactId"
        role="customer"
        value={props.value ?? ''}
        onChange={onChange}
        placeholder="Select a customer"
        searchPlaceholder="Search customers..."
      />
    </>,
  );
  return onChange;
}

/** 40 contacts: more than the 25 a plain list of the first page would hold. */
function manyContacts(): Contact[] {
  return Array.from({ length: 40 }, (_, i) => ({
    id: `cus_${i + 1}`,
    name: i === 39 ? 'Zeta Zebra Ltd' : `Customer ${String(i + 1).padStart(2, '0')}`,
    email: i === 39 ? 'ap@zeta.test' : null,
  }));
}

describe('ContactPicker', { timeout: 20_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.contacts = manyContacts();
    env.byId = {};
    env.search.mockReset().mockImplementation(async (query: string) => {
      const q = query.trim().toLowerCase();
      return env.contacts.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 30);
    });
  });

  it('lists the first contacts as soon as it opens, without typing', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('combobox', { name: 'Customer' }));
    expect(await screen.findByRole('option', { name: /Customer 01/ })).toBeInTheDocument();
    expect(env.search).toHaveBeenCalledWith('');
  });

  it('searches the server as you type, so a contact beyond the first page can be found', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('combobox', { name: 'Customer' }));
    await user.type(await screen.findByPlaceholderText('Search customers...'), 'zeta');

    expect(await screen.findByRole('option', { name: /Zeta Zebra Ltd/ })).toBeInTheDocument();
    expect(env.search).toHaveBeenLastCalledWith('zeta');
    // The email is shown under the name.
    expect(screen.getByText('ap@zeta.test')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Customer 01/ })).not.toBeInTheDocument();
  });

  it('hands the chosen contact\'s id to the form', async () => {
    const user = userEvent.setup();
    const onChange = renderPicker();

    await user.click(screen.getByRole('combobox', { name: 'Customer' }));
    await user.click(await screen.findByRole('option', { name: /Customer 02/ }));

    expect(onChange).toHaveBeenCalledWith('cus_2');
  });

  it('always shows the selected contact, even when the list does not hold it', async () => {
    env.byId = { cus_40: { id: 'cus_40', name: 'Zeta Zebra Ltd', email: 'ap@zeta.test' } };
    renderPicker({ value: 'cus_40' });

    // The server's first page (30 of 40) has no cus_40; the trigger still names it.
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveTextContent('Zeta Zebra Ltd');
  });

  it('shows the placeholder while nothing is picked', () => {
    renderPicker();
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveTextContent('Select a customer');
  });

  it('does not clear the contact when the picked one is chosen again', async () => {
    const user = userEvent.setup();
    env.byId = { cus_1: { id: 'cus_1', name: 'Customer 01' } };
    const onChange = renderPicker({ value: 'cus_1' });

    await user.click(screen.getByRole('combobox', { name: 'Customer' }));
    await user.click(await screen.findByRole('option', { name: /Customer 01/ }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('says so when no contact matches', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('combobox', { name: 'Customer' }));
    await user.type(await screen.findByPlaceholderText('Search customers...'), 'nobody');

    await waitFor(() => expect(screen.getByText(tc.pickerNoResults)).toBeInTheDocument());
  });
});
