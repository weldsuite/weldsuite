import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

/** `router.push` of the page: the list it returns to, with the new contact's panel open. */
const navigate = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ search: {} as Record<string, unknown> }));
const createAsync = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useSearch: () => route.search,
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: navigate }) }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateAccountingCustomer: () => ({ mutateAsync: createAsync, isPending: false }),
}));
// The form itself is covered by contact-form.test.tsx: here it only hands over a payload.
vi.mock('../components/contact-form', () => ({
  ContactForm: ({ onSubmit }: { onSubmit: (payload: Record<string, unknown>) => void }) => (
    <button onClick={() => onSubmit({ name: 'Dave Different', firstName: 'Dave', lastName: 'Different', email: 'other@example.com', role: 'supplier' })}>
      submit-form
    </button>
  ),
}));

import AddContactPage from './page';
import { renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const tc = en.accounting.contacts;


const personExists = Object.assign(new Error('A person with this email already exists: Olivia Other.'), {
  status: 409,
  body: {
    error: {
      code: 'CONFLICT',
      message: 'A person with this email already exists: Olivia Other.',
      details: { code: 'PERSON_EMAIL_EXISTS', existingPerson: { id: 'person_1', name: 'Olivia Other', email: 'other@example.com' } },
    },
  },
});

beforeEach(() => {
  route.search = {};
  createAsync.mockReset();
  navigate.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('new contact page: an email that belongs to another person', () => {
  it('saves straight away when there is no conflict', async () => {
    const user = userEvent.setup();
    createAsync.mockResolvedValueOnce({ data: {} });
    renderWithProviders(<AddContactPage />);

    await user.click(screen.getByText('submit-form'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/weldbooks/customers'));
    expect(createAsync).toHaveBeenCalledTimes(1);
    expect(createAsync.mock.calls[0]?.[0]).not.toHaveProperty('linkPersonId');
  });

  it('names the existing person and links to them when asked, with nothing else changed', async () => {
    const user = userEvent.setup();
    createAsync.mockRejectedValueOnce(personExists).mockResolvedValueOnce({ data: {} });
    renderWithProviders(<AddContactPage />);

    await user.click(screen.getByText('submit-form'));
    const dialog = await screen.findByTestId('person-email-conflict');
    expect(dialog).toHaveTextContent('A person with this email exists: Olivia Other.');
    expect(toast.error).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('person-email-link'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/weldbooks/customers'));
    expect(createAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ email: 'other@example.com', role: 'supplier', linkPersonId: 'person_1' }),
    );
  });

  it('creates a separate contact when asked', async () => {
    const user = userEvent.setup();
    createAsync.mockRejectedValueOnce(personExists).mockResolvedValueOnce({ data: {} });
    renderWithProviders(<AddContactPage />);

    await user.click(screen.getByText('submit-form'));
    await user.click(await screen.findByTestId('person-email-separate'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(2));
    expect(createAsync).toHaveBeenLastCalledWith(expect.objectContaining({ createSeparatePerson: true }));
    expect(createAsync.mock.calls[1]?.[0]).not.toHaveProperty('linkPersonId');
  });

  it('cancelling the choice saves nothing', async () => {
    const user = userEvent.setup();
    createAsync.mockRejectedValueOnce(personExists);
    renderWithProviders(<AddContactPage />);

    await user.click(screen.getByText('submit-form'));
    await screen.findByTestId('person-email-conflict');
    await user.click(screen.getByRole('button', { name: tc.cancel }));
    await waitFor(() => expect(screen.queryByTestId('person-email-conflict')).not.toBeInTheDocument());
    expect(createAsync).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('any other failure is a toast', async () => {
    const user = userEvent.setup();
    createAsync.mockRejectedValueOnce(Object.assign(new Error('Boom'), { status: 500, body: { error: { code: 'INTERNAL' } } }));
    renderWithProviders(<AddContactPage />);

    await user.click(screen.getByText('submit-form'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(tc.createFailed, { description: 'Boom' }));
    expect(screen.queryByTestId('person-email-conflict')).not.toBeInTheDocument();
  });
});

describe('new contact page: where it goes after saving', () => {
  it('opens the new customer in its panel on the customers list, with a toast', async () => {
    const user = userEvent.setup();
    createAsync.mockResolvedValueOnce({ data: { id: 'acn_new' } });
    renderWithProviders(<AddContactPage />);

    expect(screen.getByRole('heading', { name: 'New customer' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to customers' })).toHaveAttribute('href', '/weldbooks/customers');
    await user.click(screen.getByText('submit-form'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/weldbooks/customers?stack=weldbooks_contact:acn_new'));
    expect(toast.success).toHaveBeenCalledWith(tc.supplierCreated);
  });

  it('is the same screen for a supplier, which returns to the suppliers list', async () => {
    route.search = { role: 'supplier' };
    const user = userEvent.setup();
    createAsync.mockResolvedValueOnce({ data: { id: 'acn_sup' } });
    renderWithProviders(<AddContactPage />);

    expect(screen.getByRole('heading', { name: 'New supplier' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to suppliers' })).toHaveAttribute('href', '/weldbooks/suppliers');
    await user.click(screen.getByText('submit-form'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/weldbooks/suppliers?stack=weldbooks_contact:acn_sup'));
  });
});
