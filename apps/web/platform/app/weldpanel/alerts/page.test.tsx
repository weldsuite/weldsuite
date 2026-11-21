import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelAlertDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { makeReport } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import AlertsPage from './page';

const state = vi.hoisted(() => ({
  search: '',
  perms: new Set<string>(['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete']),
  alerts: [] as unknown[],
  listParams: [] as unknown[],
  alert: undefined as unknown,
  events: [] as unknown[],
  update: vi.fn(),
  remove: vi.fn(),
  snooze: vi.fn(),
  test: vi.fn(),
  replace: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: state.replace }),
  useSearchParams: () => new URLSearchParams(state.search),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('../components/use-members', () => ({
  useMembers: () => ({ members: [], isLoading: false, me: 'user_1', nameOf: () => 'Someone' }),
}));
// The form is covered by the lib tests; here it only has to open.
vi.mock('./alert-form-dialog', () => ({
  AlertFormDialog: ({ open, alert }: { open: boolean; alert?: { name: string } | null }) => (open ? <div role="dialog" aria-label={alert ? `edit ${alert.name}` : 'new alert'} /> : null),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelReports: () => ({ data: [makeReport({ id: 'wpr_1', name: 'Weekly signups' })] }),
}));
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useWeldPanelAlerts: (params: unknown) => {
    state.listParams.push(params);
    return { data: state.alerts, isLoading: false, isError: false, refetch: vi.fn() };
  },
  useWeldPanelAlert: (id: string) => ({ data: id ? state.alert : undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useWeldPanelAlertEvents: () => ({ data: state.events, isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateWeldPanelAlert: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteWeldPanelAlert: () => ({ mutateAsync: state.remove, isPending: false }),
  useSnoozeWeldPanelAlert: () => ({ mutateAsync: state.snooze, isPending: false }),
  useTestWeldPanelAlert: () => ({ mutateAsync: state.test, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const ta = en.weldpanel.collab.alerts;

function alert(overrides: Partial<PanelAlertDto> = {}): PanelAlertDto {
  return {
    id: 'pnal_1',
    projectId: 'wpp_1',
    name: 'Signups dropped',
    reportId: 'wpr_1',
    spec: null,
    seriesIndex: 0,
    condition: { type: 'threshold', operator: 'below', value: 100 },
    checkInterval: 'daily',
    channels: { emailUserIds: ['user_1'], inApp: true, slack: false, weldchatChannelId: null },
    enabled: true,
    state: 'firing',
    lastValue: 80,
    lastCheckedAt: '2026-11-01T06:00:00.000Z',
    lastFiredAt: '2026-11-01T06:00:00.000Z',
    lastError: null,
    snoozedUntil: null,
    nextCheckAt: '2026-11-02T06:00:00.000Z',
    ownerUserId: 'user_1',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

async function openMenu(name: string, item: string) {
  await userEvent.click(screen.getByRole('button', { name: en.common.actions.title }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

describe('Alerts', () => {
  beforeEach(() => {
    state.search = '';
    state.perms = new Set(['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete']);
    state.alerts = [alert()];
    state.listParams = [];
    state.alert = alert();
    state.events = [];
    for (const fn of [state.update, state.remove, state.snooze, state.test, state.replace, state.toast.success, state.toast.error]) fn.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists the alerts of the current project with their state and what they watch', () => {
    render(<AlertsPage />);
    expect(state.listParams[0]).toEqual({ projectId: 'wpp_1', scope: 'all' });
    expect(screen.getByText('Signups dropped')).toBeTruthy();
    expect(screen.getByText('Weekly signups')).toBeTruthy();
    expect(screen.getByText('Below 100')).toBeTruthy();
    expect(screen.getByText(ta.states.firing)).toBeTruthy();
  });

  it('opens the alert named in the link, with its history', () => {
    state.search = 'alert=pnal_1';
    state.events = [{ id: 'pnae_1', alertId: 'pnal_1', kind: 'fired', value: 80, bound: 100, message: null, createdAt: '2026-11-01T06:00:00.000Z' }];
    render(<AlertsPage />);
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText(ta.detail.historyTitle)).toBeTruthy();
    expect(within(sheet).getByText(ta.detail.events.fired)).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: ta.detail.openReport }).getAttribute('href')).toBe('/weldpanel/insights?report=wpr_1');
  });

  it('opens an alert from the list by putting it in the URL', async () => {
    render(<AlertsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.view }));
    expect(state.replace).toHaveBeenCalledWith('/weldpanel/alerts?alert=pnal_1');
  });

  it('turns an alert off', async () => {
    state.update.mockResolvedValue(alert({ enabled: false }));
    render(<AlertsPage />);
    await openMenu('Signups dropped', ta.actions.disable);
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ id: 'pnal_1', enabled: false }));
  });

  it('snoozes an alert for a day', async () => {
    state.snooze.mockResolvedValue(alert());
    render(<AlertsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.title }));
    await userEvent.click(await screen.findByRole('menuitem', { name: ta.actions.snooze }));
    await userEvent.click(await screen.findByRole('menuitem', { name: ta.actions.snooze1d }));
    await waitFor(() => expect(state.snooze).toHaveBeenCalledTimes(1));
    const until = Date.parse((state.snooze.mock.calls[0]?.[0] as { until: string }).until);
    expect(until - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });

  it('sends a test and says what each channel did', async () => {
    state.test.mockResolvedValue({ delivered: [{ channel: 'email', ok: true, recipients: 1, error: null }] });
    render(<AlertsPage />);
    await openMenu('Signups dropped', ta.actions.test);
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith(ta.tested, { description: 'Email: sent to 1' }));
  });

  it('deletes an alert after confirming', async () => {
    state.remove.mockResolvedValue(undefined);
    render(<AlertsPage />);
    await openMenu('Signups dropped', ta.actions.delete);
    const confirm = await screen.findByRole('dialog', { name: ta.deleteTitle.replace('{name}', 'Signups dropped') });
    await userEvent.click(within(confirm).getByRole('button', { name: en.weldpanel.analytics.common.delete }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('pnal_1'));
  });

  it("offers no changes on someone else's alert", async () => {
    state.alerts = [alert({ ownerUserId: 'user_2' })];
    render(<AlertsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.title }));
    expect(await screen.findByRole('menuitem', { name: ta.actions.history })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: ta.actions.edit })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: ta.actions.delete })).toBeNull();
  });

  it('shows an empty state with a way to create the first alert', async () => {
    state.alerts = [];
    render(<AlertsPage />);
    expect(screen.getByText(ta.emptyTitle)).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: ta.newAlert })[0]!);
    expect(screen.getByRole('dialog', { name: 'new alert' })).toBeTruthy();
  });

  it('has no "New alert" without the create permission', () => {
    state.perms.delete('panel_reports:create');
    render(<AlertsPage />);
    expect(screen.queryByRole('button', { name: ta.newAlert })).toBeNull();
  });
});
