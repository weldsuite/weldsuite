import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiProviderState, AiSettings } from '@weldsuite/app-api-client/schemas/ai-settings';

const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({
    can: (permission: string) => permissions.granted.has(permission),
    isLoading: false,
  }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const api = vi.hoisted(() => ({
  aiSettings: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ aiSettings: api.aiSettings }),
}));

vi.mock('@/components/access-denied-empty-state', () => ({
  AccessDeniedEmptyState: ({ permission }: { permission: string }) => <div>No access: {permission}</div>,
}));

import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/banking/feeds/test-support';
import { setRuntimeConfig } from '@/lib/runtime-config';
import AiSettingsPage from './page';

const MISTRAL: AiProviderState = {
  id: 'mistral',
  region: 'eu',
  install: true,
  offered: true,
  enabled: true,
  keySource: 'weldsuite',
  keySources: ['weldsuite'],
};
const CLAUDE: AiProviderState = {
  id: 'anthropic',
  region: 'outside-eu',
  install: false,
  offered: true,
  enabled: false,
  keySource: null,
  keySources: ['weldsuite', 'own'],
};

const MISTRAL_META = {
  provider: 'mistral',
  model: 'mistral/mistral-medium',
  region: 'eu',
} as const;

function makeSettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    installProvider: 'mistral',
    defaultProvider: 'mistral',
    providers: [MISTRAL, CLAUDE],
    features: [
      {
        id: 'mail',
        overridable: true,
        override: null,
        effective: MISTRAL_META,
        models: [
          {
            id: 'mistral/mistral-medium',
            provider: 'mistral',
            region: 'eu',
            label: 'Mistral Medium',
          },
        ],
      },
      {
        id: 'search-index',
        overridable: false,
        override: null,
        effective: {
          provider: 'mistral',
          model: 'mistral/mistral-embed',
          region: 'eu',
        },
        models: [],
      },
    ],
    canManage: true,
    ...overrides,
  };
}

let settings: AiSettings;

function installApi() {
  api.aiSettings.get = vi.fn(async () => ({
    data: JSON.parse(JSON.stringify(settings)) as AiSettings,
  }));
  api.aiSettings.usage = vi.fn(async () => ({ data: { months: [] } }));
  api.aiSettings.update = vi.fn(async () => ({
    data: JSON.parse(JSON.stringify(settings)) as AiSettings,
  }));
  api.aiSettings.setKey = vi.fn(async () => {
    settings = {
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === 'anthropic'
          ? {
              ...p,
              key: {
                hint: 'sk-…a1b2',
                status: 'ok',
                lastError: null,
                lastCheckedAt: '2026-11-13T10:00:00.000Z',
              },
            }
          : p,
      ),
    };
    return {
      data: {
        hint: 'sk-…a1b2',
        status: 'ok',
        lastError: null,
        lastCheckedAt: '2026-11-13T10:00:00.000Z',
      },
    };
  });
  api.aiSettings.testKey = vi.fn();
  api.aiSettings.removeKey = vi.fn();
}

function render(granted: string[] = ['ai:manage']) {
  permissions.granted = new Set(granted);
  return renderWithProviders(<AiSettingsPage />);
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  setRuntimeConfig({
    backend: 'rust',
    ai: {
      defaultProvider: 'mistral',
      providers: [
        { id: 'mistral', region: 'eu', keySources: ['weldsuite'] },
        {
          id: 'anthropic',
          region: 'outside-eu',
          keySources: ['weldsuite', 'own'],
        },
      ],
    },
  });
  settings = makeSettings();
  installApi();
});

afterEach(() => setRuntimeConfig(null));

describe('AiSettingsPage access', () => {
  it('asks for access and loads nothing for a member without ai:manage', async () => {
    render([]);
    expect(await screen.findByText('No access: ai:manage')).toBeInTheDocument();
    expect(api.aiSettings.get).not.toHaveBeenCalled();
  });

  it('is not offered where the install has no AI (Global)', async () => {
    setRuntimeConfig(null);
    render();
    expect(await screen.findByText('No access: ai:manage')).toBeInTheDocument();
    expect(api.aiSettings.get).not.toHaveBeenCalled();
  });
});

describe('AiSettingsPage providers', () => {
  it('shows Mistral as processed in the EU and the default, and Claude as outside the EU', async () => {
    render();
    const mistral = await screen.findByTestId('ai-provider-mistral');
    expect(within(mistral).getByText('Processed in the EU · default')).toBeInTheDocument();
    const claude = screen.getByTestId('ai-provider-anthropic');
    expect(within(claude).getByText('Outside the EU')).toBeInTheDocument();
    // The search index is fixed by WeldSuite and has no choice.
    expect(screen.getByText('Mistral, set by WeldSuite')).toBeInTheDocument();
  });

  it('enables Claude only after the acknowledgement, and sends it with the request', async () => {
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('switch', { name: 'Allow Claude' }));

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Switch on' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(api.aiSettings.update).toHaveBeenCalledTimes(1));
    expect(api.aiSettings.update).toHaveBeenCalledWith({
      providers: { anthropic: { enabled: true, keySource: 'weldsuite' } },
      acknowledgedOutsideEu: true,
    });
  });

  it('does not enable anything when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('switch', { name: 'Allow Claude' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(api.aiSettings.update).not.toHaveBeenCalled();
  });

  it('switches a provider off without asking again', async () => {
    settings = makeSettings({
      providers: [MISTRAL, { ...CLAUDE, enabled: true, keySource: 'weldsuite' }],
    });
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('switch', { name: 'Allow Claude' }));
    await waitFor(() => expect(api.aiSettings.update).toHaveBeenCalledTimes(1));
    expect(api.aiSettings.update).toHaveBeenCalledWith({
      providers: { anthropic: { enabled: false, keySource: 'weldsuite' } },
    });
  });
});

describe('AiSettingsPage own key', () => {
  beforeEach(() => {
    settings = makeSettings({
      providers: [MISTRAL, { ...CLAUDE, enabled: true, keySource: 'own', key: null }],
    });
  });

  it('masks the field, saves the key and then shows only the hint', async () => {
    const user = userEvent.setup();
    render();
    const field = await screen.findByLabelText('API key');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, 'sk-ant-supersecretvalue-a1b2');
    await user.click(screen.getByRole('button', { name: 'Save and check' }));

    await waitFor(() =>
      expect(api.aiSettings.setKey).toHaveBeenCalledWith('anthropic', {
        apiKey: 'sk-ant-supersecretvalue-a1b2',
      }),
    );
    expect(await screen.findByText('Saved key: sk-…a1b2')).toBeInTheDocument();
    expect(screen.getByText('Key works')).toBeInTheDocument();
    // The key itself is gone from the page.
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(document.body.textContent).not.toContain('supersecretvalue');
  });

  it('reports a key the provider rejects', async () => {
    api.aiSettings.setKey = vi.fn(async () => {
      throw new Error('Key rejected');
    });
    const user = userEvent.setup();
    render();
    await user.type(await screen.findByLabelText('API key'), 'sk-bad-key-1234');
    await user.click(screen.getByRole('button', { name: 'Save and check' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByText(/Saved key/)).not.toBeInTheDocument();
  });
});

describe('AiSettingsPage per feature', () => {
  it('saves a feature override together with the default provider', async () => {
    settings = makeSettings({
      providers: [MISTRAL, { ...CLAUDE, enabled: true, keySource: 'weldsuite' }],
      features: [
        {
          id: 'mail',
          overridable: true,
          override: null,
          effective: MISTRAL_META,
          models: [
            {
              id: 'mistral/mistral-medium',
              provider: 'mistral',
              region: 'eu',
              label: 'Mistral Medium',
            },
            {
              id: 'anthropic/claude-sonnet-5-5',
              provider: 'anthropic',
              region: 'outside-eu',
              label: 'Claude Sonnet',
            },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('combobox', { name: 'WeldMail' }));
    await user.click(await screen.findByRole('option', { name: 'Claude · Claude Sonnet' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.aiSettings.update).toHaveBeenCalledTimes(1));
    expect(api.aiSettings.update).toHaveBeenCalledWith({
      featureOverrides: {
        mail: { provider: 'anthropic', model: 'anthropic/claude-sonnet-5-5' },
      },
    });
  });
});
