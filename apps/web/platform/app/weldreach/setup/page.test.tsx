import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type {
  ReachBillingSummary,
  ReachDomain,
  ReachDomainCandidate,
  ReachSettings,
} from '@weldsuite/app-api-client/schemas/reach';
import { WELDREACH_DEFAULT_LIMITS } from '@weldsuite/app-api-client/schemas/reach';

const api = vi.hoisted(() => ({
  reach: {
    access: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    billing: vi.fn(),
    billingSetup: vi.fn(),
    listDomains: vi.fn(),
    domainCandidates: vi.fn(),
    connectDomain: vi.fn(),
    listMailboxes: vi.fn(),
    createMailbox: vi.fn(),
  },
}));
const router = vi.hoisted(() => ({ navigate: vi.fn(), search: {} as Record<string, string> }));
const permissions = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: permissions.can, isOwner: false }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import ReachSetupPage from './page';

const emptySettings: ReachSettings = {
  id: 'rs_1',
  senderCompanyName: null,
  senderAddress: null,
  optOutText: null,
  defaultTimezone: 'Europe/Amsterdam',
  defaultSendDays: [1, 2, 3, 4, 5],
  defaultWindowStart: '09:00',
  defaultWindowEnd: '17:00',
  defaultMailboxDailyCap: 30,
  stopOnReplyScope: 'prospect',
  onboardingCompletedAt: null,
};

const noBilling: ReachBillingSummary = {
  status: 'none',
  hasPaymentMethod: false,
  inboxCount: 0,
  unitAmountCents: 500,
  currency: 'usd',
  currentPeriodEnd: null,
};

function candidate(overrides: Partial<ReachDomainCandidate> = {}): ReachDomainCandidate {
  return { hostDomainId: 'dom_1', name: 'getacme.com', hostStatus: 'active', eligible: true, reason: null, ...overrides };
}

function connectedDomain(): ReachDomain {
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
  };
}

function list<T>(data: T[]) {
  return { data, pagination: { totalCount: data.length, hasMore: false, cursor: null } };
}

function renderWizard(step?: string) {
  router.search = step ? { step } : {};
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ReachSetupPage />
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
  router.navigate.mockReset();
  assign.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.can.mockReset();
  permissions.can.mockReturnValue(true);
  api.reach.access.mockResolvedValue({
    data: { status: 'approved', limits: WELDREACH_DEFAULT_LIMITS, usage: { domains: 0, mailboxes: 0, sendsToday: 0 }, sendingEnabled: true },
  });
  api.reach.getSettings.mockResolvedValue({ data: emptySettings });
  api.reach.billing.mockResolvedValue({ data: noBilling });
  api.reach.listDomains.mockResolvedValue(list([]));
  api.reach.listMailboxes.mockResolvedValue(list([]));
  api.reach.domainCandidates.mockResolvedValue(list([candidate()]));
});

afterEach(cleanup);

describe('Setup wizard', () => {
  it('opens on the first step that is not done yet when the URL has no step', async () => {
    renderWizard();
    await waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({ to: '/weldreach/setup', search: { step: 'identity' }, replace: true }),
    );
  });

  it('skips the steps that are already done', async () => {
    api.reach.getSettings.mockResolvedValue({
      data: { ...emptySettings, senderCompanyName: 'Acme', senderAddress: 'Street 1', optOutText: 'stop' },
    });
    api.reach.billing.mockResolvedValue({ data: { ...noBilling, hasPaymentMethod: true } });
    renderWizard();
    await waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({ to: '/weldreach/setup', search: { step: 'domains' }, replace: true }),
    );
  });

  describe('step 1: sender identity', () => {
    it('prefills the opt-out line and asks for the company and address', async () => {
      const user = userEvent.setup();
      renderWizard('identity');

      expect(await screen.findByLabelText('Opt-out line')).toHaveValue(
        'If you would rather not hear from me, reply "stop" and I will not email you again.',
      );
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      expect((await screen.findAllByText('This field is required.')).length).toBe(2);
      expect(api.reach.updateSettings).not.toHaveBeenCalled();
    });

    it('stores the identity and moves on to payment', async () => {
      api.reach.updateSettings.mockResolvedValue({ data: emptySettings });
      const user = userEvent.setup();
      renderWizard('identity');

      await user.type(await screen.findByLabelText('Company name'), 'Acme B.V.');
      await user.type(screen.getByLabelText('Company address'), 'Street 1, 1234 AB City');
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      await waitFor(() => expect(api.reach.updateSettings).toHaveBeenCalledTimes(1));
      expect(api.reach.updateSettings.mock.calls[0][0]).toMatchObject({
        senderCompanyName: 'Acme B.V.',
        senderAddress: 'Street 1, 1234 AB City',
      });
      await waitFor(() =>
        expect(router.navigate).toHaveBeenCalledWith({ to: '/weldreach/setup', search: { step: 'payment' } }),
      );
    });
  });

  describe('step 2: payment', () => {
    it('states the price and keeps Continue off until a payment method is on file', async () => {
      renderWizard('payment');

      expect(await screen.findByText('$5 per mailbox per month')).toBeInTheDocument();
      expect(screen.getByText('No payment method yet.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled();
    });

    it('sends the browser to Stripe and back to the payment step', async () => {
      api.reach.billingSetup.mockResolvedValue({ data: { url: 'https://checkout.stripe.test/s' } });
      const user = userEvent.setup();
      renderWizard('payment');

      await user.click(await screen.findByRole('button', { name: 'Add payment method' }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/s'));
      const input = api.reach.billingSetup.mock.calls[0][0] as { successUrl: string; cancelUrl: string };
      const success = new URL(input.successUrl);
      expect(success.pathname).toBe('/weldreach/setup');
      expect(success.searchParams.get('step')).toBe('payment');
      expect(success.searchParams.get('billing')).toBe('done');
      expect(new URL(input.cancelUrl).searchParams.get('billing')).toBeNull();
    });

    it('lets the user continue once a payment method is on file', async () => {
      api.reach.billing.mockResolvedValue({ data: { ...noBilling, hasPaymentMethod: true } });
      renderWizard('payment');

      expect(await screen.findByText('A payment method is on file.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });
  });

  describe('step 3: domains', () => {
    it('links to WeldHost for buying or bringing a domain and lists eligible domains', async () => {
      renderWizard('domains');

      expect(await screen.findByRole('link', { name: /Buy a domain in WeldHost/ })).toHaveAttribute(
        'href',
        '/weldhost/domains/register',
      );
      expect(screen.getByRole('link', { name: /Bring an existing domain/ })).toHaveAttribute(
        'href',
        '/weldhost/domains/external',
      );
      expect(await screen.findByText('getacme.com')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    it('explains why a domain cannot be connected', async () => {
      api.reach.domainCandidates.mockResolvedValue(
        list([
          candidate({ hostDomainId: 'a', name: 'acme.com', eligible: false, reason: 'has_mx' }),
          candidate({ hostDomainId: 'b', name: 'acme.nl', eligible: false, reason: 'has_website' }),
          candidate({ hostDomainId: 'c', name: 'acme.io', eligible: false, reason: 'not_active' }),
        ]),
      );
      renderWizard('domains');

      expect(await screen.findByText(/already receives email \(it has MX records\)/)).toBeInTheDocument();
      expect(screen.getByText(/This domain has a website/)).toBeInTheDocument();
      expect(screen.getByText(/Not active in WeldHost yet/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    });

    it('connects a domain', async () => {
      api.reach.connectDomain.mockResolvedValue({ data: connectedDomain() });
      const user = userEvent.setup();
      renderWizard('domains');

      await user.click(await screen.findByRole('button', { name: 'Connect' }));

      await waitFor(() => expect(api.reach.connectDomain).toHaveBeenCalledWith({ hostDomainId: 'dom_1' }));
      expect(toast.success).toHaveBeenCalledWith('Domain connected.');
    });
  });

  describe('step 4: mailboxes', () => {
    it('warns that a payment method is missing and offers the way back to step 2', async () => {
      api.reach.listDomains.mockResolvedValue(list([connectedDomain()]));
      const user = userEvent.setup();
      renderWizard('mailboxes');

      expect(await screen.findByText('Add a payment method in step 2 first.')).toBeInTheDocument();
      await user.click(screen.getAllByRole('button', { name: 'Add payment method' })[0]);
      expect(router.navigate).toHaveBeenCalledWith({ to: '/weldreach/setup', search: { step: 'payment' } });
    });

    it('creates a mailbox on the connected domain', async () => {
      api.reach.billing.mockResolvedValue({ data: { ...noBilling, hasPaymentMethod: true } });
      api.reach.listDomains.mockResolvedValue(list([connectedDomain()]));
      api.reach.createMailbox.mockResolvedValue({ data: { id: 'rmb_1' } });
      const user = userEvent.setup();
      renderWizard('mailboxes');

      await user.type(await screen.findByLabelText('Address'), 'anna');
      await user.type(screen.getByLabelText('First name'), 'Anna');
      await user.type(screen.getByLabelText('Last name'), 'de Vries');
      await user.click(screen.getByRole('button', { name: 'Create mailbox' }));

      await waitFor(() =>
        expect(api.reach.createMailbox).toHaveBeenCalledWith(
          expect.objectContaining({ domainId: 'rdm_1', localPart: 'anna', type: 'shared' }),
        ),
      );
    });
  });

  describe('step 5: finish', () => {
    it('completes onboarding and returns to the overview', async () => {
      api.reach.updateSettings.mockResolvedValue({ data: { ...emptySettings, onboardingCompletedAt: '2026-10-12T00:00:00.000Z' } });
      api.reach.listDomains.mockResolvedValue(list([connectedDomain()]));
      const user = userEvent.setup();
      renderWizard('done');

      expect(await screen.findByText('1 domains connected')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Go to overview' }));

      await waitFor(() => expect(api.reach.updateSettings).toHaveBeenCalledWith({ completeOnboarding: true }));
      await waitFor(() => expect(router.navigate).toHaveBeenCalledWith({ to: '/weldreach' }));
    });

    it('warns when no mailbox was created yet, but still lets the user finish', async () => {
      renderWizard('done');
      const warning = await screen.findByText(/You have not created a mailbox yet/);
      expect(warning).toBeInTheDocument();
      expect(within(document.body).getByRole('button', { name: 'Go to overview' })).toBeEnabled();
    });
  });
});
