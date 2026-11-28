import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaymentConnection } from '@/lib/api/domains/weldbooks-payments';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  canEdit: true,
  toast: { success: vi.fn(), error: vi.fn() },
  redirect: vi.fn(),
  api: {
    getConnection: vi.fn(),
    authorizeMollie: vi.fn(),
    connectWithApiKey: vi.fn(),
    updateConnection: vi.fn(),
    listMethods: vi.fn(),
    disconnect: vi.fn(),
    syncSettlements: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canEdit }));
vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ entityId: 'ent_1', setEntityId: vi.fn() }) }));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test/w/acme${path}` }));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ type, id, label }: { type: string; id: string; label: string }) => (
    <a href={`#${type}:${id}`}>{label}</a>
  ),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string) => `on ${value.slice(0, 10)}`,
    formatDateTime: (value: string) => `at ${value}`,
  }),
}));
vi.mock('@/lib/api/domains/weldbooks-payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-payments')>()),
  paymentsApi: env.api,
}));
vi.mock('@/lib/weldbooks/online-payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/weldbooks/online-payments')>()),
  redirectBrowser: env.redirect,
}));

import { renderWithProviders } from '../../invoices/components/test-utils';
import { OnlinePaymentsCard } from './online-payments-card';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

function connection(overrides: Partial<PaymentConnection> = {}): PaymentConnection {
  return {
    id: 'pc_1',
    provider: 'mollie',
    status: 'active',
    authMethod: 'oauth',
    profileId: 'pfl_1',
    profileName: 'Acme webshop',
    organizationName: 'Acme BV',
    testmode: false,
    methods: ['ideal'],
    connectedAt: '2026-11-01T09:00:00Z',
    settlementsAvailable: true,
    settlementsSyncedAt: null,
    bankAccountId: 'ba_mollie',
    lastError: null,
    ...overrides,
  };
}

function refused(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

function renderCard() {
  return renderWithProviders(<OnlinePaymentsCard />);
}

describe('OnlinePaymentsCard', () => {
  beforeEach(() => {
    setRuntimeConfig(RUST);
    env.canEdit = true;
    for (const fn of Object.values(env.api)) fn.mockReset();
    env.toast.success.mockReset();
    env.toast.error.mockReset();
    env.redirect.mockReset();
    env.api.getConnection.mockResolvedValue({ data: null });
    env.api.listMethods.mockResolvedValue({
      data: [
        { id: 'ideal', description: 'iDEAL' },
        { id: 'bancontact', description: 'Bancontact' },
        { id: 'creditcard', description: 'Credit card' },
      ],
    });
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => setRuntimeConfig(null));

  describe('not connected', () => {
    it('explains the card in owner words and offers Mollie first, the API key second', async () => {
      renderCard();
      expect(await screen.findByRole('button', { name: 'Connect Mollie' })).toBeInTheDocument();
      expect(
        screen.getByText(
          'Customers pay with iDEAL, Bancontact or card from the invoice e-mail. The money goes to your own Mollie account. Payments are booked automatically.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Use an API key instead' })).toBeInTheDocument();
      expect(screen.getByText(/asks you to confirm it is you with a second factor/)).toBeInTheDocument();
    });

    it('asks Mollie Connect to come back to the entity\'s WeldBooks tab, then goes to Mollie', async () => {
      const user = userEvent.setup();
      env.api.authorizeMollie.mockResolvedValue({ data: { authorizeUrl: 'https://my.mollie.com/oauth2/authorize?x=1' } });
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Connect Mollie' }));
      await waitFor(() => expect(env.redirect).toHaveBeenCalledWith('https://my.mollie.com/oauth2/authorize?x=1'));
      expect(env.api.authorizeMollie).toHaveBeenCalledWith('https://app.test/w/acme/settings/entities/ent_1/edit?tab=weldbooks');
    });

    it('does not go anywhere that is not https', async () => {
      const user = userEvent.setup();
      env.api.authorizeMollie.mockResolvedValue({ data: { authorizeUrl: 'javascript:alert(1)' } });
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Connect Mollie' }));
      await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Mollie could not be opened'));
      expect(env.redirect).not.toHaveBeenCalled();
    });

    it('offers only the API key, with a plain note, when the install has no Mollie Connect app', async () => {
      const user = userEvent.setup();
      env.api.authorizeMollie.mockRejectedValue(refused(409, 'MOLLIE_CONNECT_NOT_CONFIGURED', 'Not configured'));
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Connect Mollie' }));
      expect(await screen.findByTestId('mollie-not-configured')).toHaveTextContent('Connecting through Mollie is not set up on this installation');
      expect(screen.queryByRole('button', { name: 'Connect Mollie' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Mollie API key')).toBeInTheDocument();
      expect(env.redirect).not.toHaveBeenCalled();
    });

    it('helps with where to find the key and what a test key does, and hides the key until asked', async () => {
      const user = userEvent.setup();
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Use an API key instead' }));
      expect(screen.getByText(/open Developers, then API keys/)).toBeInTheDocument();
      expect(screen.getByText(/A test key starts with test_/)).toBeInTheDocument();
      const key = screen.getByLabelText('Mollie API key');
      expect(key).toHaveAttribute('type', 'password');
      await user.click(screen.getByRole('button', { name: 'Show key' }));
      expect(key).toHaveAttribute('type', 'text');
      expect(screen.getByRole('button', { name: 'Hide key' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('connects with an API key and the optional profile, and shows the connection after', async () => {
      const user = userEvent.setup();
      env.api.connectWithApiKey.mockResolvedValue({ data: connection({ authMethod: 'api_key', settlementsAvailable: false }) });
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Use an API key instead' }));
      await user.type(screen.getByLabelText('Mollie API key'), '  live_abc  ');
      await user.type(screen.getByLabelText('Profile ID (optional)'), 'pfl_9');
      env.api.getConnection.mockResolvedValue({ data: connection({ authMethod: 'api_key', settlementsAvailable: false }) });
      await user.click(screen.getByRole('button', { name: 'Connect with API key' }));
      await waitFor(() => expect(env.api.connectWithApiKey).toHaveBeenCalledWith({ apiKey: 'live_abc', profileId: 'pfl_9' }));
      expect(env.toast.success).toHaveBeenCalledWith('Mollie is connected');
      expect(await screen.findByTestId('mollie-connected')).toBeInTheDocument();
    });

    it('shows Mollie\'s message for a key it does not accept, and keeps the key', async () => {
      const user = userEvent.setup();
      env.api.connectWithApiKey.mockRejectedValue(refused(400, 'BAD_REQUEST', 'The API key is invalid'));
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Use an API key instead' }));
      const key = screen.getByLabelText('Mollie API key');
      await user.type(key, 'live_bad');
      await user.click(screen.getByRole('button', { name: 'Connect with API key' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The API key is invalid');
      expect(key).toHaveAttribute('aria-invalid', 'true');
      expect(key).toHaveValue('live_bad');
    });

    it('does not send an empty key', async () => {
      const user = userEvent.setup();
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Use an API key instead' }));
      await user.click(screen.getByRole('button', { name: 'Connect with API key' }));
      expect(env.api.connectWithApiKey).not.toHaveBeenCalled();
    });

    it('tells a member who may not change the settings, with nothing to click', async () => {
      env.canEdit = false;
      renderCard();
      expect(await screen.findByText('You need permission to change the payment settings.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect Mollie' })).not.toBeInTheDocument();
    });
  });

  describe('connected', () => {
    beforeEach(() => env.api.getConnection.mockResolvedValue({ data: connection() }));

    it('shows the organisation, the profile, how it is connected and a status', async () => {
      renderCard();
      const view = await screen.findByTestId('mollie-connected');
      expect(view).toHaveTextContent('Acme BV');
      expect(view).toHaveTextContent('Acme webshop');
      expect(view).toHaveTextContent('Connected through Mollie');
      expect(screen.getByTestId('mollie-status')).toHaveTextContent('Connected');
      expect(screen.queryByTestId('mollie-testmode')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mollie-last-error')).not.toBeInTheDocument();
    });

    it('badges test mode, and shows the last problem', async () => {
      env.api.getConnection.mockResolvedValue({ data: connection({ testmode: true, lastError: 'Mollie said no' }) });
      renderCard();
      expect(await screen.findByTestId('mollie-testmode')).toHaveTextContent('Test mode');
      expect(screen.getByTestId('mollie-last-error')).toHaveTextContent('Last problem: Mollie said no');
    });

    it('asks to reconnect when Mollie no longer accepts the connection', async () => {
      const user = userEvent.setup();
      env.api.getConnection.mockResolvedValue({ data: connection({ status: 'needs_reauth' }) });
      env.api.authorizeMollie.mockResolvedValue({ data: { authorizeUrl: 'https://my.mollie.com/oauth2/authorize' } });
      renderCard();
      const banner = await screen.findByTestId('mollie-reauth');
      expect(screen.getByTestId('mollie-status')).toHaveTextContent('Needs reconnecting');
      await user.click(within(banner).getByRole('button', { name: 'Reconnect' }));
      await waitFor(() => expect(env.redirect).toHaveBeenCalledWith('https://my.mollie.com/oauth2/authorize'));
      // A connection that needs reconnecting has no methods to pick from.
      expect(screen.queryByTestId('mollie-methods')).not.toBeInTheDocument();
    });

    it('lists the active methods with the chosen ones ticked, and saves a change through PATCH', async () => {
      const user = userEvent.setup();
      env.api.updateConnection.mockResolvedValue({ data: connection({ methods: ['ideal', 'bancontact'] }) });
      renderCard();
      const ideal = await screen.findByRole('checkbox', { name: 'iDEAL' });
      const bancontact = screen.getByRole('checkbox', { name: 'Bancontact' });
      expect(ideal).toBeChecked();
      expect(bancontact).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Card' })).not.toBeChecked();
      const save = screen.getByRole('button', { name: 'Save methods' });
      expect(save).toBeDisabled();
      await user.click(bancontact);
      await user.click(save);
      await waitFor(() => expect(env.api.updateConnection).toHaveBeenCalledWith('pc_1', { methods: ['ideal', 'bancontact'] }));
      expect(env.toast.success).toHaveBeenCalledWith('Payment methods saved');
    });

    it('does not save with no method chosen', async () => {
      const user = userEvent.setup();
      renderCard();
      await user.click(await screen.findByRole('checkbox', { name: 'iDEAL' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one method.');
      expect(screen.getByRole('button', { name: 'Save methods' })).toBeDisabled();
    });

    it('syncs payouts and sums up what came of it', async () => {
      const user = userEvent.setup();
      env.api.syncSettlements.mockResolvedValue({
        data: { imported: 12, skipped: 3, lines: 12, booked: 9, toProcess: 3, fees: 4, payouts: 2 },
      });
      renderCard();
      const payouts = await screen.findByTestId('mollie-payouts');
      await user.click(within(payouts).getByRole('button', { name: 'Sync payouts now' }));
      await waitFor(() => expect(env.api.syncSettlements).toHaveBeenCalledWith('pc_1'));
      expect(await screen.findByTestId('mollie-sync-result')).toHaveTextContent(
        '12 new lines read, 3 already known. 9 of 12 lines booked automatically, 3 waiting in To process. 2 payouts and 4 fees.',
      );
      expect(env.toast.success).toHaveBeenCalledWith('Payouts synced');
    });

    it('says why payouts cannot be read with an API key, and offers no sync', async () => {
      env.api.getConnection.mockResolvedValue({ data: connection({ authMethod: 'api_key', settlementsAvailable: false }) });
      renderCard();
      expect(await screen.findByTestId('mollie-payouts-unavailable')).toHaveTextContent(
        "Payouts can't be read with an API key. Connect through Mollie to have payouts and fees booked automatically.",
      );
      expect(screen.queryByRole('button', { name: 'Sync payouts now' })).not.toBeInTheDocument();
    });

    it('says so when the server refuses a sync for an API key anyway', async () => {
      const user = userEvent.setup();
      env.api.syncSettlements.mockRejectedValue(refused(409, 'SETTLEMENTS_UNAVAILABLE', 'No'));
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Sync payouts now' }));
      await waitFor(() =>
        expect(env.toast.error).toHaveBeenCalledWith('The payouts could not be synced', {
          description: 'Payouts can only be read when you are connected through Mollie.',
        }),
      );
    });

    it('links to the Mollie money account, which opens as a panel', async () => {
      renderCard();
      const account = await screen.findByTestId('mollie-account');
      expect(within(account).getByRole('link', { name: 'Open the Mollie account' })).toHaveAttribute('href', '#bank_account:ba_mollie');
    });

    it('says the account is made with the first payment when there is none yet', async () => {
      env.api.getConnection.mockResolvedValue({ data: connection({ bankAccountId: null }) });
      renderCard();
      expect(await screen.findByText('The account is made when the first payment comes in.')).toBeInTheDocument();
    });

    it('disconnects only after a confirmation', async () => {
      const user = userEvent.setup();
      env.api.disconnect.mockResolvedValue(undefined);
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
      expect(env.api.disconnect).not.toHaveBeenCalled();
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Disconnect Mollie?');
      await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
      await waitFor(() => expect(env.api.disconnect).toHaveBeenCalledWith('pc_1'));
      expect(env.toast.success).toHaveBeenCalledWith('Mollie disconnected');
    });

    it('keeps the connection when the person keeps it', async () => {
      const user = userEvent.setup();
      renderCard();
      await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep connected' }));
      expect(env.api.disconnect).not.toHaveBeenCalled();
    });

    it('hides every change from a member who may not make them', async () => {
      env.canEdit = false;
      renderCard();
      await screen.findByTestId('mollie-connected');
      expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sync payouts now' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save methods' })).not.toBeInTheDocument();
    });
  });

  describe('loading the connection', () => {
    it('says so, and tries again, when it cannot be read', async () => {
      const user = userEvent.setup();
      env.api.getConnection.mockRejectedValueOnce(new Error('offline'));
      renderCard();
      expect(await screen.findByRole('alert')).toHaveTextContent('The online payment settings could not be loaded.');
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('button', { name: 'Connect Mollie' })).toBeInTheDocument();
    });
  });

  describe('coming back from Mollie', () => {
    it('welcomes the connection and clears the param, keeping the tab', async () => {
      window.history.replaceState(null, '', '/settings/entities/ent_1/edit?tab=weldbooks&mollie=connected');
      renderCard();
      const banner = await screen.findByTestId('mollie-return');
      expect(banner).toHaveTextContent('Mollie is connected');
      expect(banner).toHaveTextContent('Customers can now pay your invoices online.');
      expect(window.location.search).toBe('?tab=weldbooks');
    });

    it('shows the reason of an error and clears both params', async () => {
      window.history.replaceState(null, '', '/settings/entities/ent_1/edit?tab=weldbooks&mollie=error&reason=access_denied');
      renderCard();
      const banner = await screen.findByTestId('mollie-return');
      expect(banner).toHaveTextContent('Connecting Mollie did not work');
      expect(banner).toHaveTextContent('access_denied');
      expect(window.location.search).toBe('?tab=weldbooks');
    });

    it('shows nothing when this is not a return', async () => {
      window.history.replaceState(null, '', '/settings/entities/ent_1/edit?tab=weldbooks');
      renderCard();
      await screen.findByRole('button', { name: 'Connect Mollie' });
      expect(screen.queryByTestId('mollie-return')).not.toBeInTheDocument();
    });
  });
});
