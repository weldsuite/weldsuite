import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { ReachBillingSummary, ReachSettings, ReachSuppression } from '@weldsuite/app-api-client/schemas/reach';

const api = vi.hoisted(() => ({
  reach: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    billing: vi.fn(),
    billingSetup: vi.fn(),
    listSuppressions: vi.fn(),
    addSuppressions: vi.fn(),
    deleteSuppression: vi.fn(),
  },
}));
const permissions = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: permissions.can, isOwner: false }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: vi.fn() }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ orgSlug: 'acme', orgId: 'org_acme' }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useSearch: () => ({}) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import ReachSettingsPage from './page';

const settings: ReachSettings = {
  id: 'rs_1',
  senderCompanyName: 'Acme B.V.',
  senderAddress: 'Street 1, 1234 AB Amsterdam',
  optOutText: 'Reply "stop" to opt out.',
  defaultTimezone: 'Europe/Amsterdam',
  defaultSendDays: [1, 2, 3, 4, 5],
  defaultWindowStart: '09:00',
  defaultWindowEnd: '17:00',
  defaultMailboxDailyCap: 30,
  stopOnReplyScope: 'prospect',
  onboardingCompletedAt: '2026-10-05T00:00:00.000Z',
};

const billing: ReachBillingSummary = {
  status: 'active',
  hasPaymentMethod: true,
  inboxCount: 4,
  unitAmountCents: 500,
  currency: 'usd',
  currentPeriodEnd: '2026-11-01T00:00:00.000Z',
};

function suppression(overrides: Partial<ReachSuppression> = {}): ReachSuppression {
  return {
    id: 'sup_1',
    value: 'bob@bigcorp.com',
    type: 'email',
    reason: 'unsubscribed',
    source: null,
    createdBy: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function list<T>(data: T[]) {
  return { data, pagination: { totalCount: data.length, hasMore: false, cursor: null } };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ReachSettingsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const assign = vi.fn();

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, origin: 'https://app.test', assign },
  });
});

beforeEach(() => {
  for (const fn of Object.values(api.reach)) fn.mockReset();
  assign.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.can.mockReset();
  permissions.can.mockReturnValue(true);
  api.reach.getSettings.mockResolvedValue({ data: settings });
  api.reach.billing.mockResolvedValue({ data: billing });
  api.reach.listSuppressions.mockResolvedValue(list([suppression()]));
});

afterEach(cleanup);

describe('Settings page', () => {
  it('loads the stored settings and only enables Save after a change', async () => {
    const user = userEvent.setup();
    renderPage();

    const company = await screen.findByLabelText('Company name');
    expect(company).toHaveValue('Acme B.V.');
    expect(screen.getByLabelText('Company address')).toHaveValue('Street 1, 1234 AB Amsterdam');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();

    await user.type(company, ' Holding');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
  });

  it('saves the changed settings and reports it', async () => {
    api.reach.updateSettings.mockResolvedValue({ data: { ...settings, senderCompanyName: 'Acme Holding' } });
    const user = userEvent.setup();
    renderPage();

    const company = await screen.findByLabelText('Company name');
    await user.clear(company);
    await user.type(company, 'Acme Holding');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(api.reach.updateSettings).toHaveBeenCalledTimes(1));
    expect(api.reach.updateSettings.mock.calls[0][0]).toMatchObject({
      senderCompanyName: 'Acme Holding',
      defaultTimezone: 'Europe/Amsterdam',
      defaultSendDays: [1, 2, 3, 4, 5],
      defaultWindowStart: '09:00',
      defaultMailboxDailyCap: 30,
      stopOnReplyScope: 'prospect',
    });
    expect(api.reach.updateSettings.mock.calls[0][0]).not.toHaveProperty('completeOnboarding');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings saved.'));
  });

  it('does not save an emptied sender identity', async () => {
    const user = userEvent.setup();
    renderPage();

    const company = await screen.findByLabelText('Company name');
    await user.clear(company);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    expect(api.reach.updateSettings).not.toHaveBeenCalled();
  });

  it('keeps the daily limit within the mailbox maximum', async () => {
    const user = userEvent.setup();
    renderPage();

    const cap = await screen.findByLabelText('Daily limit per mailbox');
    await user.clear(cap);
    await user.type(cap, '80');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('Must be at most 50.')).toBeInTheDocument();
    expect(api.reach.updateSettings).not.toHaveBeenCalled();
  });

  it('is read-only without reach_settings:update', async () => {
    permissions.can.mockImplementation((key: string) => key.endsWith(':read'));
    renderPage();

    expect(await screen.findByLabelText('Company name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to list' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update payment method' })).not.toBeInTheDocument();
  });
});

describe('Suppression list', () => {
  it('lists suppressed addresses with their reason', async () => {
    renderPage();
    expect(await screen.findByText('bob@bigcorp.com')).toBeInTheDocument();
    expect(screen.getByText('Unsubscribed')).toBeInTheDocument();
  });

  it('adds addresses and domains from pasted text, skipping duplicates', async () => {
    api.reach.addSuppressions.mockResolvedValue({ data: { added: 2 } });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Add to list' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Carol@Corp.com, corp.com{enter}carol@corp.com');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.reach.addSuppressions).toHaveBeenCalledWith(['carol@corp.com', 'corp.com']));
    expect(toast.success).toHaveBeenCalledWith('2 added to the suppression list.');
  });

  it('points at values that are neither an email nor a domain', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Add to list' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'ok@corp.com not-valid');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    expect(await within(dialog).findByText(/These do not look like email addresses or domains: not-valid/)).toBeInTheDocument();
    expect(api.reach.addSuppressions).not.toHaveBeenCalled();
  });

  it('removes an entry after confirming', async () => {
    api.reach.deleteSuppression.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('bob@bigcorp.com');
    await user.click(screen.getByRole('button', { name: 'Remove from list' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove bob@bigcorp.com from the list?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove from list' }));

    await waitFor(() => expect(api.reach.deleteSuppression).toHaveBeenCalledWith('sup_1'));
  });
});

describe('Billing summary', () => {
  it('shows the monthly total of the mailboxes', async () => {
    renderPage();
    expect(await screen.findByText('4 × $5')).toBeInTheDocument();
    expect(screen.getByText('$20')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('On file')).toBeInTheDocument();
  });

  it('warns about a failed payment', async () => {
    api.reach.billing.mockResolvedValue({ data: { ...billing, status: 'past_due' } });
    renderPage();

    expect(await screen.findByText('Your last payment failed')).toBeInTheDocument();
    expect(screen.getByText('Payment failed')).toBeInTheDocument();
  });

  it('sends the browser to Stripe and back to this page', async () => {
    api.reach.billingSetup.mockResolvedValue({ data: { url: 'https://checkout.stripe.test/session' } });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Update payment method' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/session'));
    expect(api.reach.billingSetup).toHaveBeenCalledWith({
      successUrl: 'https://app.test/w/acme/weldreach/settings?billing=done',
      cancelUrl: 'https://app.test/w/acme/weldreach/settings',
    });
  });
});
