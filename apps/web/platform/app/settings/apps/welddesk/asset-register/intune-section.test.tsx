import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { AssetSource } from '@weldsuite/core-api-client/schemas/asset-sources';

const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  useCan: (permission: string) => permissions.granted.has(permission),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));

const api = vi.hoisted(() => ({ assetSources: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ assetSources: api.assetSources }) }));

const templates = vi.hoisted(() => ({ installed: true }));
vi.mock('@/hooks/queries/use-custom-objects-queries', () => ({
  useCustomObjectTemplates: () => ({
    data: [{ key: 'asset', slug: 'asset', installed: templates.installed }],
    isLoading: false,
  }),
}));

import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/banking/feeds/test-support';
import { IntuneSection } from './intune-section';

const ti = en.assetSources.intune;
const tf = ti.form;

const SECRET = 'my-client-secret-value';
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'cccccccc-2222-3333-4444-555555555555';

function makeSource(overrides: Partial<AssetSource> = {}): AssetSource {
  return {
    id: 'asrc_1',
    type: 'intune',
    name: 'Contoso Intune',
    objectSlug: 'asset',
    config: { tenantId: TENANT, clientId: CLIENT },
    hasSecret: true,
    enabled: true,
    intervalHours: 24,
    nextSyncAt: '2026-11-11T08:00:00.000Z',
    lastStatus: 'ok',
    lastSyncAt: '2026-11-10T08:00:00.000Z',
    lastError: null,
    lastErrorCode: null,
    lastStats: { total: 12, created: 7, updated: 3, unchanged: 1, failed: 1 },
    progress: null,
    createdById: 'user_1',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...overrides,
  };
}

const list = <T,>(data: T[]) => ({ data: JSON.parse(JSON.stringify(data)) as T[], pagination: { totalCount: data.length, hasMore: false, cursor: null } });
const refusal = (status: number, code: string, message = 'refused') => new ApiError(message, status, { error: { code, message } });

let sources: AssetSource[];

function render(granted: string[] = ['weldobjects:manage']) {
  permissions.granted = new Set(granted);
  return renderWithProviders(<IntuneSection />);
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  templates.installed = true;
  sources = [];
  api.assetSources.list = vi.fn(async () => list(sources));
  api.assetSources.create = vi.fn(async () => ({ data: makeSource() }));
  api.assetSources.update = vi.fn(async () => ({ data: makeSource() }));
  api.assetSources.delete = vi.fn(async () => undefined);
  api.assetSources.sync = vi.fn(async () => ({ data: makeSource({ lastStatus: 'running' }) }));
  api.assetSources.testNew = vi.fn(async () => ({ data: { ok: true, deviceCount: 25 } }));
  api.assetSources.test = vi.fn(async () => ({ data: { ok: true, deviceCount: 25 } }));
});

describe('IntuneSection access and register', () => {
  it('renders nothing, and loads nothing, without weldobjects:manage', () => {
    const { container } = render(['weldobjects:read']);
    expect(container).toBeEmptyDOMElement();
    expect(api.assetSources.list).not.toHaveBeenCalled();
  });

  it('asks to set up the asset register first when it is not installed', async () => {
    templates.installed = false;
    render();
    expect(await screen.findByText(en.assetSources.registerMissing)).toBeInTheDocument();
    expect(screen.queryByTestId('intune-connect')).not.toBeInTheDocument();
  });

  it('offers a retry when the sources cannot be loaded', async () => {
    api.assetSources.list = vi.fn().mockRejectedValueOnce(refusal(500, 'INTERNAL_ERROR')).mockResolvedValue(list(sources));
    render();
    expect(await screen.findByText(en.assetSources.loadFailed)).toBeInTheDocument();
  });
});

describe('IntuneSection not connected', () => {
  it('explains the connection, lists the five setup steps and shows the form', async () => {
    render();
    expect(await screen.findByTestId('intune-connect')).toBeInTheDocument();
    expect(screen.getByText(ti.notConnected)).toBeInTheDocument();
    for (const step of Object.values(ti.steps)) expect(screen.getByText(step)).toBeInTheDocument();
    expect(screen.getByLabelText(tf.name)).toBeInTheDocument();
    expect(screen.getByLabelText(tf.tenantId)).toBeInTheDocument();
    expect(screen.getByLabelText(tf.clientId)).toBeInTheDocument();
    expect(screen.getByLabelText(tf.secret)).toHaveAttribute('type', 'password');
  });

  it('validates the fields before it calls the API', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByTestId('intune-connect');

    await user.click(screen.getByRole('button', { name: tf.connect }));
    expect(screen.getByText(tf.nameRequired)).toBeInTheDocument();
    expect(screen.getByText(tf.tenantInvalid)).toBeInTheDocument();
    expect(screen.getByText(tf.clientRequired)).toBeInTheDocument();
    expect(screen.getByText(tf.secretRequired)).toBeInTheDocument();

    await user.type(screen.getByLabelText(tf.tenantId), 'not/a/tenant');
    await user.click(screen.getByRole('button', { name: tf.testConnection }));
    expect(screen.getByText(tf.tenantInvalid)).toBeInTheDocument();
    expect(api.assetSources.create).not.toHaveBeenCalled();
    expect(api.assetSources.testNew).not.toHaveBeenCalled();
  });

  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(tf.name), ' Contoso Intune ');
    await user.type(screen.getByLabelText(tf.tenantId), ` ${TENANT} `);
    await user.type(screen.getByLabelText(tf.clientId), CLIENT);
    await user.type(screen.getByLabelText(tf.secret), SECRET);
  }

  it('tests the connection without saving it and reports the device count', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByTestId('intune-connect');
    await fill(user);

    await user.click(screen.getByRole('button', { name: tf.testConnection }));

    expect(await screen.findByTestId('intune-test-ok')).toHaveTextContent(tf.testOk.replace('{count}', '25'));
    expect(api.assetSources.testNew).toHaveBeenCalledWith({ config: { tenantId: TENANT, clientId: CLIENT }, secret: SECRET });
    expect(api.assetSources.create).not.toHaveBeenCalled();
  });

  it('shows the failed test in the member\'s own words, by error code', async () => {
    const user = userEvent.setup();
    api.assetSources.testNew = vi.fn(async () => ({ data: { ok: false, code: 'permission_missing', message: 'english from the API' } }));
    render();
    await screen.findByTestId('intune-connect');
    await fill(user);

    await user.click(screen.getByRole('button', { name: tf.testConnection }));

    expect(await screen.findByTestId('intune-test-failed')).toHaveTextContent(ti.errors.permission_missing);
  });

  it('connects with the trimmed values and says the first import starts shortly', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByTestId('intune-connect');
    await fill(user);

    await user.click(screen.getByRole('button', { name: tf.connect }));

    await waitFor(() =>
      expect(api.assetSources.create).toHaveBeenCalledWith({ name: 'Contoso Intune', config: { tenantId: TENANT, clientId: CLIENT }, secret: SECRET }),
    );
    expect(toast.success).toHaveBeenCalledWith(tf.connected);
  });

  it('says so when the app registration is already connected', async () => {
    const user = userEvent.setup();
    api.assetSources.create = vi.fn().mockRejectedValue(refusal(409, 'CONFLICT'));
    render();
    await screen.findByTestId('intune-connect');
    await fill(user);

    await user.click(screen.getByRole('button', { name: tf.connect }));

    expect(await screen.findByText(tf.duplicate)).toBeInTheDocument();
  });
});

describe('IntuneSection connected', () => {
  it('shows the status, the last import with its counts and the next scheduled import, never the secret', async () => {
    sources = [makeSource()];
    const { container } = render();

    expect(await screen.findByText('Contoso Intune')).toBeInTheDocument();
    expect(screen.getByTestId('intune-status')).toHaveTextContent(ti.status.ok);
    expect(screen.getByText(ti.lastImport)).toBeInTheDocument();
    expect(screen.getByText(ti.nextImport)).toBeInTheDocument();
    for (const [label, value] of [
      [ti.stats.total, '12'],
      [ti.stats.created, '7'],
      [ti.stats.updated, '3'],
      [ti.stats.unchanged, '1'],
      [ti.stats.failed, '1'],
    ] as const) {
      expect(screen.getByText(label).parentElement).toHaveTextContent(value);
    }
    expect(screen.getByText(TENANT)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(SECRET);
    expect(screen.queryByTestId('intune-progress')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intune-connect')).not.toBeInTheDocument();
  });

  it('shows the progress of a running import and cannot start another', async () => {
    sources = [makeSource({ lastStatus: 'running', progress: { startedAt: '2026-11-10T08:00:00.000Z', stats: { total: 80, created: 70, updated: 5, unchanged: 5, failed: 0 }, startedById: 'user_1' } })];
    render();

    expect(await screen.findByTestId('intune-progress')).toHaveTextContent(ti.progress.replace('{count}', '80'));
    expect(screen.getByTestId('intune-status')).toHaveTextContent(ti.status.running);
    expect(screen.getByTestId('intune-sync-now')).toBeDisabled();
  });

  it('shows a failed import with the wording of its error code', async () => {
    sources = [makeSource({ lastStatus: 'failed', lastError: 'english from the API', lastErrorCode: 'secret_expired' })];
    render();

    expect(await screen.findByTestId('intune-last-error')).toHaveTextContent(ti.errors.secret_expired);
    expect(screen.getByTestId('intune-last-error')).toHaveTextContent(ti.lastErrorTitle);
    expect(screen.getByTestId('intune-status')).toHaveTextContent(ti.status.failed);
  });

  it('syncs now, and tells when an import is already running', async () => {
    const user = userEvent.setup();
    sources = [makeSource()];
    render();
    await screen.findByText('Contoso Intune');

    await user.click(screen.getByTestId('intune-sync-now'));
    await waitFor(() => expect(api.assetSources.sync).toHaveBeenCalledWith('asrc_1'));
    expect(toast.success).toHaveBeenCalledWith(ti.syncStarted);

    api.assetSources.sync = vi.fn().mockRejectedValue(refusal(409, 'already_running'));
    await user.click(screen.getByTestId('intune-sync-now'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(ti.alreadyRunning));
  });

  it('turns the schedule off and says when it is off', async () => {
    const user = userEvent.setup();
    sources = [makeSource()];
    render();
    await screen.findByText('Contoso Intune');

    await user.click(screen.getByRole('switch', { name: ti.schedule.title }));

    await waitFor(() => expect(api.assetSources.update).toHaveBeenCalledWith('asrc_1', { enabled: false }));
  });

  it('shows that scheduled imports are off', async () => {
    sources = [makeSource({ enabled: false, nextSyncAt: null })];
    render();
    expect(await screen.findByText(ti.scheduleOff)).toBeInTheDocument();
    expect(screen.queryByLabelText(ti.schedule.interval)).not.toBeInTheDocument();
  });

  it('replaces the secret, write-only, after an optional test', async () => {
    const user = userEvent.setup();
    sources = [makeSource()];
    render();
    await screen.findByText('Contoso Intune');

    await user.click(screen.getByRole('button', { name: ti.secretDialog.open }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: ti.secretDialog.save })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(tf.secret), ` ${SECRET} `);

    await user.click(within(dialog).getByRole('button', { name: ti.secretDialog.test }));
    await waitFor(() => expect(api.assetSources.test).toHaveBeenCalledWith('asrc_1', { secret: SECRET }));
    expect(await within(dialog).findByText(ti.secretDialog.testOk)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: ti.secretDialog.save }));
    await waitFor(() => expect(api.assetSources.update).toHaveBeenCalledWith('asrc_1', { secret: SECRET }));
    expect(toast.success).toHaveBeenCalledWith(ti.secretDialog.saved);
  });

  it('disconnects after confirming, and says the assets stay', async () => {
    const user = userEvent.setup();
    sources = [makeSource()];
    render();
    await screen.findByText('Contoso Intune');

    await user.click(screen.getByTestId('intune-disconnect'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ti.disconnect.description)).toBeInTheDocument();
    expect(api.assetSources.delete).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: ti.disconnect.confirm }));
    await waitFor(() => expect(api.assetSources.delete).toHaveBeenCalledWith('asrc_1'));
    expect(toast.success).toHaveBeenCalledWith(ti.disconnect.done);
  });
});
