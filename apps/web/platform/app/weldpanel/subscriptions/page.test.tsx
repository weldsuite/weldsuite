import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelSubscriptionDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { makeReport } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import SubscriptionsPage from './page';

const state = vi.hoisted(() => ({
  perms: new Set<string>(),
  subscriptions: [] as unknown[],
  update: vi.fn(),
  remove: vi.fn(),
  sendNow: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en-GB', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('../components/use-members', () => ({ useMembers: () => ({ members: [], isLoading: false, me: 'user_1', nameOf: () => 'Someone' }) }));
vi.mock('./subscription-form-dialog', () => ({
  SubscriptionFormDialog: ({ open, subscription }: { open: boolean; subscription?: { name: string } | null }) =>
    open ? <div role="dialog" aria-label={subscription ? `edit ${subscription.name}` : 'new schedule'} /> : null,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelReports: () => ({ data: [makeReport({ id: 'wpr_1', name: 'Weekly signups' })] }),
  useWeldPanelDashboards: () => ({ data: [] }),
}));
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useWeldPanelSubscriptions: () => ({ data: state.subscriptions, isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateWeldPanelSubscription: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteWeldPanelSubscription: () => ({ mutateAsync: state.remove, isPending: false }),
  useSendWeldPanelSubscriptionNow: () => ({ mutateAsync: state.sendNow, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const ts = en.weldpanel.collab.subscriptions;

function subscription(overrides: Partial<PanelSubscriptionDto> = {}): PanelSubscriptionDto {
  return {
    id: 'pnsb_1',
    projectId: 'wpp_1',
    name: 'Monday numbers',
    targetType: 'report',
    targetId: 'wpr_1',
    schedule: { frequency: 'weekly', hour: 9, weekday: 1, timezone: 'Europe/Amsterdam' },
    channels: { emailUserIds: ['user_1', 'user_2'], inApp: false, slack: true, weldchatChannelId: null },
    enabled: true,
    nextRunAt: '2026-11-23T08:00:00.000Z',
    lastRunAt: null,
    lastError: null,
    ownerUserId: 'user_1',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('Scheduled reports', () => {
  beforeEach(() => {
    state.perms = new Set(['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete']);
    state.subscriptions = [subscription()];
    for (const fn of [state.update, state.remove, state.sendNow, state.toast.success, state.toast.error]) fn.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists what goes out, when and where', () => {
    render(<SubscriptionsPage />);
    expect(screen.getByText('Monday numbers')).toBeTruthy();
    expect(screen.getByText('Weekly signups')).toBeTruthy();
    expect(screen.getByText('Every Monday at 09:00 (Europe/Amsterdam)')).toBeTruthy();
    expect(screen.getByText('2 by email · Slack')).toBeTruthy();
  });

  it('turns a schedule off', async () => {
    state.update.mockResolvedValue(subscription({ enabled: false }));
    render(<SubscriptionsPage />);
    await userEvent.click(screen.getByRole('switch', { name: ts.toggleLabel.replace('{name}', 'Monday numbers') }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ id: 'pnsb_1', enabled: false }));
  });

  it('sends one now', async () => {
    state.sendNow.mockResolvedValue({ delivered: [{ channel: 'slack', ok: false, recipients: 0, error: 'invalid_token' }] });
    render(<SubscriptionsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.title }));
    await userEvent.click(await screen.findByRole('menuitem', { name: ts.actions.sendNow }));
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith(ts.sent, { description: 'Slack: invalid_token' }));
  });

  it('deletes one after confirming', async () => {
    state.remove.mockResolvedValue(undefined);
    render(<SubscriptionsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.title }));
    await userEvent.click(await screen.findByRole('menuitem', { name: ts.actions.delete }));
    const confirm = await screen.findByRole('dialog', { name: ts.deleteTitle.replace('{name}', 'Monday numbers') });
    await userEvent.click(within(confirm).getByRole('button', { name: en.weldpanel.analytics.common.delete }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('pnsb_1'));
  });

  it("can't change someone else's schedule", () => {
    state.subscriptions = [subscription({ ownerUserId: 'user_2' })];
    render(<SubscriptionsPage />);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: en.common.actions.title })).toBeNull();
  });

  it('shows an empty state that opens the form', async () => {
    state.subscriptions = [];
    render(<SubscriptionsPage />);
    expect(screen.getByText(ts.emptyTitle)).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: ts.newSubscription })[0]!);
    expect(screen.getByRole('dialog', { name: 'new schedule' })).toBeTruthy();
  });
});
