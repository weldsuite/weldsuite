import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import type { ReachDomain } from '@weldsuite/app-api-client/schemas/reach';

const api = vi.hoisted(() => ({
  reach: { createMailbox: vi.fn(), billingSetup: vi.fn() },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
// The wizard and the "New mailbox" dialog both read `?billing=done` through TanStack Router; not needed here.
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ orgSlug: 'acme', orgId: 'org_acme' }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useSearch: () => ({}) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { CreateMailboxForm } from './create-mailbox-form';

function domain(overrides: Partial<ReachDomain> = {}): ReachDomain {
  return {
    id: 'rdm_1',
    hostDomainId: 'dom_1',
    name: 'getacme.com',
    mailpoolDomainId: 'mp_1',
    status: 'active',
    dnsStatus: null,
    dmarcPolicy: null,
    connectedAt: '2026-10-01T00:00:00.000Z',
    lastError: null,
    mailboxCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderForm(props: Partial<React.ComponentProps<typeof CreateMailboxForm>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onCreated = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <CreateMailboxForm
          domains={[domain()]}
          paymentReturnPath="/weldreach/mailboxes"
          onCreated={onCreated}
          {...props}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onCreated };
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  api.reach.createMailbox.mockReset();
  api.reach.billingSetup.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

async function fill(user: ReturnType<typeof userEvent.setup>, localPart = 'anna') {
  await user.type(screen.getByLabelText('Address'), localPart);
  await user.type(screen.getByLabelText('First name'), 'Anna');
  await user.type(screen.getByLabelText('Last name'), 'de Vries');
}

describe('CreateMailboxForm', () => {
  it('shows the price and the address on the chosen domain', () => {
    renderForm();
    expect(screen.getByText('@getacme.com')).toBeInTheDocument();
    expect(screen.getByText(/\$5 per month, billed to your payment method/)).toBeInTheDocument();
  });

  it('asks for a connected domain first when there is none', () => {
    renderForm({ domains: [] });
    expect(screen.getByText('Connect a domain first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create mailbox' })).not.toBeInTheDocument();
  });

  it('creates the mailbox with the contract payload', async () => {
    api.reach.createMailbox.mockResolvedValue({ data: { id: 'rmb_1', email: 'anna@getacme.com' } });
    const user = userEvent.setup();
    const { onCreated } = renderForm();
    await fill(user, 'Anna');
    await user.click(screen.getByRole('button', { name: 'Create mailbox' }));

    await waitFor(() => expect(api.reach.createMailbox).toHaveBeenCalledTimes(1));
    expect(api.reach.createMailbox).toHaveBeenCalledWith({
      domainId: 'rdm_1',
      localPart: 'anna',
      firstName: 'Anna',
      lastName: 'de Vries',
      signature: undefined,
      type: 'shared',
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Mailbox created. It starts warming up now.');
  });

  it('turns 402 PAYMENT_METHOD_REQUIRED into a prompt to add a payment method', async () => {
    api.reach.createMailbox.mockRejectedValue(
      new ApiError('Payment method required', 402, { error: { code: 'PAYMENT_METHOD_REQUIRED', message: 'x' } }),
    );
    const user = userEvent.setup();
    const { onCreated } = renderForm();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create mailbox' }));

    expect(await screen.findByText('Add a payment method first')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add payment method' })).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('explains an invalid address in the UI language', async () => {
    const user = userEvent.setup();
    renderForm();
    await fill(user, 'bad name!');
    await user.click(screen.getByRole('button', { name: 'Create mailbox' }));

    expect(await screen.findByText('Use letters, digits, dots, dashes and underscores only.')).toBeInTheDocument();
    expect(api.reach.createMailbox).not.toHaveBeenCalled();
  });

  it('shows the server message for other failures, such as a limit', async () => {
    api.reach.createMailbox.mockRejectedValue(
      new ApiError('Mailbox limit reached (10)', 409, { error: { code: 'LIMIT_REACHED', message: 'Mailbox limit reached (10)' } }),
    );
    const user = userEvent.setup();
    renderForm();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create mailbox' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Mailbox limit reached (10)'));
  });
});
