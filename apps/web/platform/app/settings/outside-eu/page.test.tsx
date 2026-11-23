import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OutsideEuService, OutsideEuServices } from '@weldsuite/app-api-client/schemas/outside-eu-services';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const api = vi.hoisted(() => ({
  outsideEuServices: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ outsideEuServices: api.outsideEuServices }),
}));

vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/banking/feeds/test-support';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { OutsideEuNotice } from '@/components/outside-eu/outside-eu-notice';
import OutsideEuSettingsPage from './page';
import { countryName, fill, groupServices, switchedOnText } from './outside-eu-view';
import { en } from '@weldsuite/i18n/locales/en';

const TELNYX: OutsideEuService = {
  id: 'telnyx',
  name: 'Telnyx',
  company: 'Telnyx LLC',
  country: 'US',
  data: 'Phone numbers, calls and their recordings, text messages and caller details',
  account: 'weldsuite',
  uses: [{ module: 'call', key: 'call-telephony', label: 'WeldCall phone numbers, calls and recordings' }],
  enabled: false,
};
const SLACK: OutsideEuService = {
  id: 'slack',
  name: 'Slack',
  company: 'Slack Technologies, LLC (Salesforce)',
  country: 'US',
  data: 'Messages, channels and the people in them',
  account: 'workspace',
  uses: [{ module: 'desk', key: 'desk-slack', label: 'The WeldDesk Slack channel' }],
  enabled: true,
  enabledBy: 'user_admin',
  enabledByName: 'Ada Admin',
  enabledAt: '2026-11-20T10:00:00.000Z',
  acknowledgedAt: '2026-11-20T10:00:00.000Z',
  via: 'admin',
};

let state: OutsideEuServices;

function makeState(overrides: Partial<OutsideEuServices> = {}): OutsideEuServices {
  return {
    enforced: true,
    canManage: true,
    settingsPath: '/settings/outside-eu',
    services: [TELNYX, SLACK],
    integrations: { telnyx: 'telnyx', slack: 'slack', gmail: 'google' },
    ...overrides,
  };
}

function installApi() {
  api.outsideEuServices.list = vi.fn(async () => ({ data: JSON.parse(JSON.stringify(state)) as OutsideEuServices }));
  api.outsideEuServices.switch = vi.fn(async (service: string, input: { enabled: boolean }) => {
    const current = state.services.find((s) => s.id === service) as OutsideEuService;
    const next = { ...current, enabled: input.enabled };
    state = { ...state, services: state.services.map((s) => (s.id === service ? next : s)) };
    return { data: next };
  });
}

/** The EU edition's `/config.json`: everything but the Rust-only features unavailable is enough here. */
const EU = { backend: 'rust', edition: 'eu', unavailableFeatures: [] as string[] };

beforeAll(installPointerPolyfills);

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  setRuntimeConfig(EU);
  state = makeState();
  installApi();
});

afterEach(() => setRuntimeConfig(null));

describe('OutsideEuSettingsPage', () => {
  it('lists each service with its "Leaves the EU" label, where it goes and what uses it', async () => {
    renderWithProviders(<OutsideEuSettingsPage />);
    const telnyx = await screen.findByTestId('outside-eu-telnyx');
    expect(within(telnyx).getByText('Leaves the EU')).toBeInTheDocument();
    expect(within(telnyx).getByText('Telnyx LLC, United States')).toBeInTheDocument();
    expect(within(telnyx).getByText('WeldCall phone numbers, calls and recordings')).toBeInTheDocument();
    expect(within(telnyx).getByRole('switch', { name: 'Allow Telnyx' })).not.toBeChecked();
    // Grouped: WeldSuite's account first, then what the workspace connects.
    expect(screen.getByText("Run on WeldSuite's account")).toBeInTheDocument();
    expect(screen.getByText('Integrations you connect')).toBeInTheDocument();
    const slack = screen.getByTestId('outside-eu-slack');
    expect(within(slack).getByText(/Switched on by Ada Admin/)).toBeInTheDocument();
  });

  it('switches a service on only after the acknowledgement, and sends it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OutsideEuSettingsPage />);
    await user.click(await screen.findByRole('switch', { name: 'Allow Telnyx' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Where it goes: Telnyx LLC, United States, outside the EU/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Switch on' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(api.outsideEuServices.switch).toHaveBeenCalledTimes(1));
    expect(api.outsideEuServices.switch).toHaveBeenCalledWith('telnyx', {
      enabled: true,
      acknowledgedOutsideEu: true,
    });
    expect(toast.success).toHaveBeenCalledWith('Telnyx is switched on');
  });

  it('does not switch anything on when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OutsideEuSettingsPage />);
    await user.click(await screen.findByRole('switch', { name: 'Allow Telnyx' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.outsideEuServices.switch).not.toHaveBeenCalled();
  });

  it('switches a service off without asking', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OutsideEuSettingsPage />);
    await user.click(await screen.findByRole('switch', { name: 'Allow Slack' }));
    await waitFor(() => expect(api.outsideEuServices.switch).toHaveBeenCalledWith('slack', { enabled: false }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is read-only for a member who may not manage it', async () => {
    state = makeState({ canManage: false });
    renderWithProviders(<OutsideEuSettingsPage />);
    expect(await screen.findByText('Only a workspace owner or admin can switch these services on or off.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Allow Telnyx' })).toBeDisabled();
  });

  it('asks nothing of the backend where the install does not offer it (Global, self-hosted)', async () => {
    setRuntimeConfig(null);
    renderWithProviders(<OutsideEuSettingsPage />);
    expect(await screen.findByText('This installation does not restrict services outside the EU.')).toBeInTheDocument();
    expect(api.outsideEuServices.list).not.toHaveBeenCalled();
    setRuntimeConfig({ ...EU, edition: 'self-hosted', unavailableFeatures: ['outside-eu-services'] });
    renderWithProviders(<OutsideEuSettingsPage />);
    expect(api.outsideEuServices.list).not.toHaveBeenCalled();
  });
});

describe('OutsideEuNotice', () => {
  it('names a switched-off service and links to the switches', async () => {
    renderWithProviders(<OutsideEuNotice services={['telnyx', 'gmail', 'moneybird']} />);
    const notice = await screen.findByTestId('outside-eu-notice');
    expect(within(notice).getByText('Switched off: Telnyx')).toBeInTheDocument();
    expect(within(notice).getByRole('link', { name: 'Services outside the EU' })).toHaveAttribute(
      'href',
      '/settings/outside-eu',
    );
  });

  it('notes a service that is on, and shows nothing for EU services or where nothing is enforced', async () => {
    renderWithProviders(<OutsideEuNotice services={['slack']} />);
    expect(await screen.findByText('Uses Slack, outside the EU, as switched on for this workspace.')).toBeInTheDocument();

    state = makeState({ enforced: false });
    installApi();
    const { container } = renderWithProviders(<OutsideEuNotice services={['telnyx']} />);
    await waitFor(() => expect(api.outsideEuServices.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('outside-eu view', () => {
  const strings = en.settings.outsideEu;

  it('fills placeholders and names countries', () => {
    expect(fill('{a} and {b} and {c}', { a: '1', b: '2' })).toBe('1 and 2 and {c}');
    expect(countryName(strings, 'GB')).toBe('United Kingdom');
    expect(countryName(strings, 'ZZ')).toBe('ZZ');
  });

  it('says who switched a service on, staff and the move from Global included', () => {
    const date = () => '20/11/2026';
    expect(switchedOnText(strings, SLACK, date)).toBe('Switched on by Ada Admin on 20/11/2026.');
    expect(switchedOnText(strings, { ...SLACK, via: 'staff' }, date)).toBe('Switched on by WeldSuite on 20/11/2026.');
    expect(switchedOnText(strings, { ...SLACK, via: 'move' }, date)).toMatch(/^Kept from before the workspace moved/);
    expect(switchedOnText(strings, TELNYX, date)).toBeNull();
  });

  it('groups by whose account the service runs on', () => {
    expect(groupServices([SLACK, TELNYX])).toEqual({ weldsuite: [TELNYX], workspace: [SLACK] });
  });
});
