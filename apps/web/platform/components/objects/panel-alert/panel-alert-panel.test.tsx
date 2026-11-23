import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelAlertDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';
import { makeReport } from '@/app/weldpanel/analytics-fixtures';
import { PanelAlertPanel, matchesEventFilter } from './panel-alert-panel';
import { panelAlertHref } from './panel-alert-tabs';

const state = vi.hoisted(() => ({
  allowed: new Set(['panel_reports:update', 'panel_reports:delete']),
  alert: { data: undefined as unknown, isLoading: false, isError: false, error: null as unknown, refetch: vi.fn() },
  events: [] as unknown[],
  remove: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.allowed.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/app/weldpanel/components/use-members', () => ({
  useMembers: () => ({ members: [], isLoading: false, me: 'user_1', nameOf: () => 'Someone' }),
}));
// The form has its own tests; here it only has to open.
vi.mock('@/app/weldpanel/alerts/alert-form-dialog', () => ({
  AlertFormDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="edit alert" /> : null),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelReports: () => ({ data: [makeReport({ id: 'wpr_1', name: 'Weekly signups' })] }),
}));
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useWeldPanelAlert: () => state.alert,
  useWeldPanelAlertEvents: () => ({ data: state.events, isLoading: false, isError: false, refetch: vi.fn() }),
  useDeleteWeldPanelAlert: () => ({ mutateAsync: state.remove, isPending: false }),
  useUpdateWeldPanelAlert: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSnoozeWeldPanelAlert: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestWeldPanelAlert: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const ta = en.weldpanel.collab.alerts;

function makeAlert(overrides: Partial<PanelAlertDto> = {}): PanelAlertDto {
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

const ok = (data: PanelAlertDto = makeAlert()) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });

function renderPanel(initialTab?: string, onClose = vi.fn()) {
  renderWithProviders(<PanelAlertPanel id="pnal_1" isOpen onClose={onClose} mode="fullscreen" onModeChange={vi.fn()} initialTab={initialTab} />);
  return onClose;
}

describe('panel alert links', () => {
  it('opens the Alerts list with the panel, on the tab asked for', () => {
    expect(panelAlertHref('pnal_1')).toBe('/weldpanel/alerts?stack=panel_alert:pnal_1');
    expect(panelAlertHref('pnal_1', 'history')).toBe('/weldpanel/alerts?stack=panel_alert:pnal_1:tab=history');
  });
});

describe('history filter', () => {
  it('keeps the events of the kind picked, or all but it', () => {
    expect(matchesEventFilter({ kind: 'fired' }, { id: '1', field: 'kind', operator: 'is', value: 'fired' })).toBe(true);
    expect(matchesEventFilter({ kind: 'resolved' }, { id: '2', field: 'kind', operator: 'is', value: 'fired' })).toBe(false);
    expect(matchesEventFilter({ kind: 'fired' }, { id: '3', field: 'kind', operator: 'is not', value: 'fired' })).toBe(false);
    expect(matchesEventFilter({ kind: 'error' }, { id: '4', field: 'kind', operator: 'is', value: '' })).toBe(true);
  });
});

describe('PanelAlertPanel', () => {
  beforeEach(() => {
    state.allowed = new Set(['panel_reports:update', 'panel_reports:delete']);
    state.alert = ok();
    state.events = [];
    state.remove.mockReset();
    state.toast.success.mockReset();
  });

  it('shows the alert as rows: state, what it watches, the condition, and a link to the report', () => {
    renderPanel();
    expect(screen.getByText('Signups dropped')).toBeTruthy();
    expect(screen.getByText(ta.states.firing)).toBeTruthy();
    expect(screen.getByText('Weekly signups')).toBeTruthy();
    expect(screen.getByText(`Below 100 · ${ta.intervals.daily}`)).toBeTruthy();
    expect(screen.getByRole('link', { name: ta.detail.openReport }).getAttribute('href')).toBe('/weldpanel/insights?report=wpr_1');
  });

  it('lists the history as rows', async () => {
    state.events = [{ id: 'pnae_1', alertId: 'pnal_1', kind: 'fired', value: 80, bound: 100, message: 'Signups were 80.', createdAt: '2026-11-01T06:00:00.000Z' }];
    renderPanel();
    await userEvent.click(screen.getByRole('tab', { name: ta.detail.historyTitle }));
    expect(screen.getByText(ta.detail.events.fired)).toBeTruthy();
    expect(screen.getByText('Signups were 80.')).toBeTruthy();
    expect(screen.getByText('value 80, bound 100')).toBeTruthy();
  });

  it('opens on the history tab when the link asks for it', () => {
    renderPanel('history');
    expect(screen.getByText(ta.detail.historyEmpty)).toBeTruthy();
  });

  it('deletes the alert from the menu and closes the panel', async () => {
    state.remove.mockResolvedValue(undefined);
    const onClose = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: ta.actions.menu.replace('{name}', 'Signups dropped') }));
    await userEvent.click(await screen.findByRole('menuitem', { name: ta.actions.delete }));
    await userEvent.click(await screen.findByRole('button', { name: en.weldpanel.analytics.common.delete }));
    expect(state.remove).toHaveBeenCalledWith('pnal_1');
    expect(onClose).toHaveBeenCalled();
  });

  it("offers no menu on someone else's alert", () => {
    state.alert = ok(makeAlert({ ownerUserId: 'user_2' }));
    renderPanel();
    expect(screen.queryByRole('button', { name: ta.actions.menu.replace('{name}', 'Signups dropped') })).toBeNull();
  });

  it('says so for an alert that does not exist', () => {
    state.alert = { data: undefined, isLoading: false, isError: true, error: new ApiError('Not found', 404), refetch: vi.fn() };
    renderPanel();
    expect(screen.getByText(ta.notFound)).toBeTruthy();
  });
});
