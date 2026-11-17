import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { AnnotationEditDialog } from './annotation-dialogs';
import { ChartCard } from './chart-card';
import { CommentsPanel } from './comments-panel';
import { SharePanel } from './share-dialog';

const state = vi.hoisted(() => ({
  perms: new Set<string>(),
  me: 'user_1',
  links: [] as unknown[],
  comments: [] as unknown[],
  createLink: vi.fn(),
  revokeLink: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  createAnnotation: vi.fn(),
  download: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('./use-members', () => ({
  useMembers: () => ({ members: [], isLoading: false, me: state.me, nameOf: (id: string, labels: { you: string }) => (id === state.me ? labels.you : 'Sam') }),
}));
vi.mock('../lib/csv', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/csv')>()), downloadCsv: state.download }));
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useWeldPanelShareLinks: () => ({ data: state.links, isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateWeldPanelShareLink: () => ({ mutateAsync: state.createLink, isPending: false }),
  useRevokeWeldPanelShareLink: () => ({ mutateAsync: state.revokeLink, isPending: false }),
  useWeldPanelComments: () => ({ data: state.comments, isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateWeldPanelComment: () => ({ mutateAsync: state.createComment, isPending: false }),
  useUpdateWeldPanelComment: () => ({ mutateAsync: state.updateComment, isPending: false }),
  useDeleteWeldPanelComment: () => ({ mutateAsync: state.deleteComment, isPending: false }),
  useCreateWeldPanelAnnotation: () => ({ mutateAsync: state.createAnnotation, isPending: false }),
  useUpdateWeldPanelAnnotation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const tc = en.weldpanel.collab;
const ALL = ['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete'];
const reportTarget = { targetType: 'report' as const, targetId: 'wpr_1', name: 'Weekly signups', ownerUserId: 'user_1', visibility: 'private' as const };

beforeEach(() => {
  state.perms = new Set(ALL);
  state.me = 'user_1';
  state.links = [];
  state.comments = [];
  for (const fn of [state.createLink, state.revokeLink, state.createComment, state.updateComment, state.deleteComment, state.createAnnotation, state.download, state.toast.success, state.toast.error]) fn.mockReset();
});

describe('ChartCard', () => {
  it('offers "Export CSV" once there is something to export', async () => {
    const csv = () => ({ filename: 'signups-2026-11-01', rows: [{ bucket: '2026-11-01', value: 3 }] });
    const { rerender } = render(
      <ChartCard title="Signups" loading csv={csv}>
        chart
      </ChartCard>,
    );
    expect(screen.queryByRole('button', { name: tc.csv.export })).toBeNull();
    rerender(
      <ChartCard title="Signups" csv={csv}>
        chart
      </ChartCard>,
    );
    await userEvent.click(screen.getByRole('button', { name: tc.csv.export }));
    expect(state.download).toHaveBeenCalledWith({ filename: 'signups-2026-11-01', rows: [{ bucket: '2026-11-01', value: 3 }] });
  });
});

describe('SharePanel', () => {
  it('creates a link and shows it, with the embed code, once', async () => {
    state.createLink.mockResolvedValue({ id: 'pnsl_1', allowEmbed: true, url: 'https://app.test/share/panel/wpsh_abc' });
    render(<SharePanel target={reportTarget} />);
    await userEvent.click(screen.getByRole('switch', { name: tc.share.embedLabel }));
    await userEvent.click(screen.getByRole('button', { name: tc.share.create }));
    await waitFor(() => expect(state.createLink).toHaveBeenCalledTimes(1));
    expect(state.createLink.mock.calls[0]?.[0]).toEqual({ targetType: 'report', targetId: 'wpr_1', allowEmbed: true, allowDateChange: true, expiresAt: null });
    expect(await screen.findByText(tc.share.onceTitle)).toBeTruthy();
    expect(screen.getByText('https://app.test/share/panel/wpsh_abc')).toBeTruthy();
    expect(screen.getByText(/<iframe src="https:\/\/app\.test\/share\/panel\/wpsh_abc\?embed=1"/)).toBeTruthy();
  });

  it('says which report holds people data when sharing is refused', async () => {
    state.createLink.mockRejectedValue(
      new ApiError('Unprocessable', 422, { error: { code: 'NOT_SHAREABLE', message: 'x', details: { reasons: [{ reportId: 'wpr_2', reason: 'person_breakdown' }] } } }),
    );
    render(<SharePanel target={{ ...reportTarget, targetType: 'dashboard', targetId: 'wpd_1', name: 'Board', reportNames: new Map([['wpr_2', 'Signups by plan']]) }} />);
    await userEvent.click(screen.getByRole('button', { name: tc.share.create }));
    expect(await screen.findByText(tc.share.refusedTitle)).toBeTruthy();
    expect(screen.getByText('Signups by plan')).toBeTruthy();
    expect(screen.getByText(/broken down by a user property/)).toBeTruthy();
  });

  it("does not offer to share someone else's private report", () => {
    render(<SharePanel target={{ ...reportTarget, ownerUserId: 'user_2' }} />);
    expect(screen.queryByRole('button', { name: tc.share.create })).toBeNull();
    expect(screen.getByText(tc.share.noPermission)).toBeTruthy();
  });

  it('lists links with their state and revokes an active one', async () => {
    state.links = [
      { id: 'pnsl_1', prefix: 'wpsh_ab12', allowEmbed: false, allowDateChange: true, expiresAt: null, revokedAt: null, lastViewedAt: null, viewCount: 12, createdByUserId: 'user_1' },
      { id: 'pnsl_2', prefix: 'wpsh_cd34', allowEmbed: true, allowDateChange: false, expiresAt: null, revokedAt: '2026-10-01T00:00:00Z', lastViewedAt: null, viewCount: 0, createdByUserId: 'user_1' },
    ];
    state.revokeLink.mockResolvedValue(undefined);
    render(<SharePanel target={reportTarget} />);
    expect(screen.getByText('12 views')).toBeTruthy();
    expect(screen.getByText(tc.share.revoked)).toBeTruthy();
    const revokeButtons = screen.getAllByRole('button', { name: tc.share.revoke });
    expect(revokeButtons).toHaveLength(1);
    await userEvent.click(revokeButtons[0]!);
    const confirm = await screen.findByRole('dialog', { name: tc.share.revokeTitle });
    await userEvent.click(within(confirm).getByRole('button', { name: tc.share.revoke }));
    await waitFor(() => expect(state.revokeLink).toHaveBeenCalledWith('pnsl_1'));
  });
});

describe('CommentsPanel', () => {
  const target = { targetType: 'report' as const, targetId: 'wpr_1' };

  it('posts a comment', async () => {
    state.createComment.mockResolvedValue({});
    render(<CommentsPanel target={target} />);
    await userEvent.type(screen.getByRole('textbox', { name: tc.comments.label }), 'Looks like a **spike**');
    await userEvent.click(screen.getByRole('button', { name: tc.comments.post }));
    await waitFor(() => expect(state.createComment).toHaveBeenCalledWith({ targetType: 'report', targetId: 'wpr_1', body: 'Looks like a **spike**' }));
  });

  it('renders comments as Markdown and lets the author edit their own only', async () => {
    state.comments = [
      { id: 'pncm_1', targetType: 'report', targetId: 'wpr_1', body: 'Mine with **bold**', authorUserId: 'user_1', edited: false, createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z' },
      { id: 'pncm_2', targetType: 'report', targetId: 'wpr_1', body: 'Theirs', authorUserId: 'user_2', edited: true, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T11:00:00Z' },
    ];
    state.updateComment.mockResolvedValue({});
    render(<CommentsPanel target={target} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText(/edited/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: tc.comments.actions })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: tc.comments.actions }));
    await userEvent.click(await screen.findByRole('menuitem', { name: en.weldpanel.analytics.common.edit }));
    const box = screen.getAllByRole('textbox', { name: tc.comments.label })[0]!;
    await userEvent.clear(box);
    await userEvent.type(box, 'Changed');
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.common.save }));
    await waitFor(() => expect(state.updateComment).toHaveBeenCalledWith({ id: 'pncm_1', body: 'Changed' }));
  });

  it('lets a project manager delete anyone\'s comment', async () => {
    state.perms = new Set([...ALL, 'panel_projects:manage']);
    state.comments = [{ id: 'pncm_2', targetType: 'report', targetId: 'wpr_1', body: 'Theirs', authorUserId: 'user_2', edited: false, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z' }];
    state.deleteComment.mockResolvedValue(undefined);
    render(<CommentsPanel target={target} />);
    await userEvent.click(screen.getByRole('button', { name: tc.comments.actions }));
    expect(screen.queryByRole('menuitem', { name: en.weldpanel.analytics.common.edit })).toBeNull();
    await userEvent.click(await screen.findByRole('menuitem', { name: en.weldpanel.analytics.common.delete }));
    const confirm = await screen.findByRole('dialog', { name: tc.comments.deleteTitle });
    await userEvent.click(within(confirm).getByRole('button', { name: en.weldpanel.analytics.common.delete }));
    await waitFor(() => expect(state.deleteComment).toHaveBeenCalledWith('pncm_2'));
  });
});

describe('AnnotationEditDialog', () => {
  it('adds an annotation pinned to the open report', async () => {
    state.createAnnotation.mockResolvedValue({});
    render(<AnnotationEditDialog open onOpenChange={vi.fn()} projectId="wpp_1" reportId="wpr_1" defaultOccurredAt="2026-11-02T12:00:00.000Z" />);
    await userEvent.type(screen.getByLabelText(tc.annotations.labelLabel), 'Pricing launch');
    await userEvent.click(screen.getByRole('radio', { name: tc.annotations.scopeReport }));
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.common.add }));
    await waitFor(() => expect(state.createAnnotation).toHaveBeenCalledTimes(1));
    expect(state.createAnnotation.mock.calls[0]?.[0]).toEqual({ projectId: 'wpp_1', label: 'Pricing launch', description: null, occurredAt: '2026-11-02T12:00:00.000Z', reportId: 'wpr_1' });
  });

  it('needs a label', async () => {
    render(<AnnotationEditDialog open onOpenChange={vi.fn()} projectId="wpp_1" />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.common.add }));
    expect(await screen.findByText(tc.annotations.labelRequired)).toBeTruthy();
    expect(state.createAnnotation).not.toHaveBeenCalled();
  });
});
