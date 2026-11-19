import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelExportDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { resetCurrentProjectChoice } from '@/app/weldpanel/lib/use-current-project';
import { makeProject } from '@/app/weldpanel/test-fixtures';
import { parseSettingsSearch } from './search';
import WeldPanelSettingsPage from './page';

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  exports: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  pause: vi.fn(),
  test: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@tanstack/react-router', () => ({ useSearch: () => state.search }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/lib/runtime-config', () => ({ publicEnv: () => 'https://api.example.test/' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelUsage: () => ({ data: undefined, isLoading: true, error: null, refetch: vi.fn(), isFetching: false }),
}));
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useWeldPanelExports: () => ({ data: state.exports, isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelExportRuns: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateWeldPanelExport: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateWeldPanelExport: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteWeldPanelExport: () => ({ mutateAsync: state.remove, isPending: false }),
  usePauseWeldPanelExport: () => ({ mutateAsync: state.pause, isPending: false }),
  useTestWeldPanelExport: () => ({ mutateAsync: state.test, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const te = en.weldpanel.collab.exports;

function exportItem(overrides: Partial<PanelExportDto> = {}): PanelExportDto {
  return {
    id: 'pnex_1',
    projectId: 'wpp_1',
    name: 'Data lake',
    destination: { provider: 'r2', endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'analytics', prefix: 'weldpanel', accessKeyId: 'AKIA1', pathStyle: false },
    tables: ['events', 'people'],
    frequency: 'hourly',
    startAt: '2026-10-01T00:00:00.000Z',
    exportedUntil: null,
    status: 'failing',
    lastRunAt: null,
    lastError: 'AccessDenied',
    nextRunAt: null,
    createdByUserId: 'user_1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('WeldPanel settings: data export and API access', () => {
  beforeEach(() => {
    state.search = { tab: 'exports' };
    state.exports = [exportItem()];
    for (const fn of [state.create, state.update, state.remove, state.pause, state.test, state.toast.success, state.toast.error, state.toast.warning]) fn.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('accepts the new tabs in the URL (the "export failing" email links to ?tab=exports)', () => {
    expect(parseSettingsSearch({ tab: 'exports' })).toEqual({ tab: 'exports' });
    expect(parseSettingsSearch({ tab: 'api' })).toEqual({ tab: 'api' });
  });

  it("lists the project's exports with the erasure notice", () => {
    render(<WeldPanelSettingsPage />);
    expect(screen.getByText(te.erasureTitle)).toBeTruthy();
    expect(screen.getByText('Data lake')).toBeTruthy();
    expect(screen.getByText(te.statuses.failing)).toBeTruthy();
    expect(screen.getByText('Last error: AccessDenied')).toBeTruthy();
  });

  it('says which project the exports belong to, since Settings has no WeldPanel header', () => {
    render(<WeldPanelSettingsPage />);
    const picker = screen.getByTestId('weldpanel-settings-project');
    expect(within(picker).getByText(en.weldpanel.analytics.projectBar.label)).toBeTruthy();
    expect(within(picker).getByRole('combobox').textContent).toContain('Marketing site');
  });

  it('tests the connection of a saved export with its stored key', async () => {
    state.test.mockResolvedValue({ ok: true, wrote: true, deleted: true, error: null });
    render(<WeldPanelSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.title }));
    await userEvent.click(await screen.findByRole('menuitem', { name: te.actions.test }));
    await waitFor(() => expect(state.test).toHaveBeenCalledWith({ exportId: 'pnex_1' }));
    expect(state.toast.success).toHaveBeenCalledWith(te.test.ok);
  });

  it('resumes a paused export', async () => {
    state.exports = [exportItem({ status: 'paused' })];
    state.pause.mockResolvedValue(exportItem());
    render(<WeldPanelSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.title }));
    await userEvent.click(await screen.findByRole('menuitem', { name: te.actions.resume }));
    await waitFor(() => expect(state.pause).toHaveBeenCalledWith({ id: 'pnex_1', pause: false }));
  });

  it('creates an export: the secret key is required and sent once', async () => {
    state.exports = [];
    state.create.mockResolvedValue(exportItem());
    render(<WeldPanelSettingsPage />);
    await userEvent.click(screen.getAllByRole('button', { name: te.newExport })[0]!);
    const dialog = await screen.findByRole('dialog', { name: te.form.createTitle });
    await userEvent.type(within(dialog).getByLabelText(te.form.nameLabel), 'Lake');
    await userEvent.type(within(dialog).getByLabelText(te.form.bucketLabel), 'my-bucket');
    await userEvent.type(within(dialog).getByLabelText(te.form.accessKeyLabel), 'AKIA2');
    await userEvent.click(within(dialog).getByRole('button', { name: te.form.create }));
    expect(await within(dialog).findAllByText(te.form.required)).toHaveLength(1);
    expect(state.create).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(te.form.secretKeyLabel), 'shh');
    await userEvent.click(within(dialog).getByRole('button', { name: te.form.create }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'wpp_1',
      name: 'Lake',
      secretAccessKey: 'shh',
      destination: { provider: 's3', endpoint: null, region: 'eu-central-1', bucket: 'my-bucket', prefix: 'weldpanel', accessKeyId: 'AKIA2', pathStyle: false },
      tables: ['events'],
      frequency: 'daily',
    });
  });

  it('shows the API base URL, the scope and the MCP tools', () => {
    state.search = { tab: 'api' };
    render(<WeldPanelSettingsPage />);
    expect(screen.getByText('https://api.example.test/v1/panel')).toBeTruthy();
    expect(screen.getByText('panel:read')).toBeTruthy();
    expect(screen.getByText('weldpanel_get_report_results')).toBeTruthy();
    expect(screen.getByRole('link', { name: en.weldpanel.collab.api.createKey }).getAttribute('href')).toBe('/settings/api-keys');
  });
});
