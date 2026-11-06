import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { MergeReleaseDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { makeIssue, makePullRequest } from '../../test-fixtures';
import WeldMergeReleasePage from './page';

const state = vi.hoisted(() => ({
  can: true,
  query: { isLoading: false, isError: false, data: undefined as unknown, refetch: vi.fn() },
  update: vi.fn(),
  refresh: vi.fn(),
  generate: vi.fn(),
  ship: vi.fn(),
  remove: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.can, useCanAny: () => state.can }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-weldmerge-across-queries', () => ({
  useMergeRelease: () => state.query,
  useUpdateMergeRelease: () => ({ mutate: state.update, isPending: false }),
  useRefreshMergeRelease: () => ({ mutate: state.refresh, isPending: false }),
  useGenerateMergeReleaseNotes: () => ({ mutate: state.generate, isPending: false }),
  useShipMergeRelease: () => ({ mutateAsync: state.ship, isPending: false }),
  useDeleteMergeRelease: () => ({ mutateAsync: state.remove, isPending: false }),
}));
vi.mock('../publish-dialog', () => ({ PublishReleaseDialog: ({ open }: { open: boolean }) => (open ? <div>publish dialog</div> : null) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({ releaseId: 'mrl_1' }),
  useRouter: () => ({ push: state.push }),
}));

function detail(overrides: Partial<MergeReleaseDetailDto> = {}): MergeReleaseDetailDto {
  return {
    id: 'mrl_1',
    teamId: 'mtm_1',
    repositoryId: 'mrp_1',
    repositoryFullName: 'acme/api',
    name: 'Spring release',
    version: 'v1.4.0',
    baseRef: 'v1.3.0',
    headRef: 'v1.4.0',
    status: 'draft',
    notes: '## Fixes\n\n- Login is faster',
    notesGeneratedAt: null,
    knowledgePageId: null,
    shippedAt: null,
    pullRequestCount: 1,
    createdByUserId: 'user_1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    pullRequests: [makePullRequest()],
    issues: [makeIssue()],
    tickets: [{ ticketId: 'tkt_1', title: 'Cannot log in', issueId: 'mis_1', issueKey: 'PLAT-209' }],
    ...overrides,
  };
}

describe('WeldMerge release detail', () => {
  beforeEach(() => {
    state.can = true;
    state.query = { isLoading: false, isError: false, data: detail(), refetch: vi.fn() };
    state.update = vi.fn();
    state.refresh = vi.fn();
    state.generate = vi.fn();
    state.ship = vi.fn().mockResolvedValue({});
    state.remove = vi.fn().mockResolvedValue(undefined);
    state.push = vi.fn();
  });

  it('shows the pull requests, issues and the customers waiting', () => {
    render(<WeldMergeReleasePage />);
    expect(screen.getByText('Spring release')).toBeTruthy();
    expect(screen.getByText('feat(weldflow): tab visibility per project')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Tab visibility per project/ }).getAttribute('href')).toBe('/weldmerge/issues/PLAT-209');
    expect(screen.getByRole('link', { name: /Cannot log in/ }).getAttribute('href')).toBe('/welddesk/tickets/tkt_1');
    expect(screen.getByText('Login is faster')).toBeTruthy();
  });

  it('refreshes from the provider and generates notes, with the credit cost spelled out', () => {
    render(<WeldMergeReleasePage />);
    expect(screen.getByText(en.weldmerge.across.releases.detail.generateCost)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.releases.detail.refresh }));
    expect(state.refresh).toHaveBeenCalledWith('mrl_1', expect.any(Object));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.releases.detail.generateNotes) }));
    expect(state.generate).toHaveBeenCalledWith('mrl_1', expect.any(Object));
  });

  it('edits the notes and saves them', () => {
    render(<WeldMergeReleasePage />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.releases.detail.notesEdit) }));
    fireEvent.change(screen.getByRole('textbox', { name: en.weldmerge.across.releases.detail.notes }), { target: { value: 'New notes' } });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.releases.detail.notesSave) }));
    expect(state.update).toHaveBeenCalledWith({ id: 'mrl_1', input: { notes: 'New notes' } }, expect.any(Object));
  });

  it('asks before shipping, then ships', async () => {
    render(<WeldMergeReleasePage />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en.weldmerge.across.releases.detail.ship}$`) }));
    expect(screen.getByText('Ship Spring release?')).toBeTruthy();
    expect(state.ship).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.releases.detail.shipConfirm }));
    await waitFor(() => expect(state.ship).toHaveBeenCalledWith('mrl_1'));
  });

  it('opens the publish dialog', () => {
    render(<WeldMergeReleasePage />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.releases.detail.publish) }));
    expect(screen.getByText('publish dialog')).toBeTruthy();
  });

  it('is read-only once shipped: no ship, refresh or notes editing', () => {
    state.query.data = detail({ status: 'shipped', shippedAt: '2026-11-05T09:00:00.000Z' });
    render(<WeldMergeReleasePage />);
    expect(screen.queryByRole('button', { name: new RegExp(`^${en.weldmerge.across.releases.detail.ship}$`) })).toBeNull();
    expect(screen.queryByRole('button', { name: en.weldmerge.across.releases.detail.refresh })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(en.weldmerge.across.releases.detail.notesEdit) })).toBeNull();
    expect(screen.getByText(en.weldmerge.across.releases.detail.shippedNoEdit)).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.releases.detail.publish) })).toBeTruthy();
  });

  it('hides every action without merge_releases:manage', () => {
    state.can = false;
    render(<WeldMergeReleasePage />);
    expect(screen.queryByRole('button', { name: new RegExp(en.weldmerge.across.releases.detail.publish) })).toBeNull();
    expect(screen.queryByRole('button', { name: en.weldmerge.across.releases.detail.refresh })).toBeNull();
    expect(screen.queryByRole('button', { name: en.weldmerge.across.releases.detail.deleteRelease })).toBeNull();
  });

  it('shows a not-found state', () => {
    state.query = { isLoading: false, isError: true, data: undefined, refetch: vi.fn() };
    render(<WeldMergeReleasePage />);
    expect(screen.getByText(en.weldmerge.across.releases.detail.notFound)).toBeTruthy();
  });
});
