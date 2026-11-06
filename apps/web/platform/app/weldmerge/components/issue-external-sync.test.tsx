import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { MergeIssueDetailDto, MergeRepositoryDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { IssueExternalSync } from './issue-external-sync';
import { makeIssue } from '../test-fixtures';

const state = vi.hoisted(() => ({
  can: true,
  repositories: { isLoading: false, data: [] as unknown[] },
  create: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.can }));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({ useMergeRepositories: () => state.repositories }));
vi.mock('@/hooks/queries/use-weldmerge-sync-queries', () => ({
  useCreateMergeExternalIssue: () => ({ mutateAsync: state.create, isPending: false }),
  useRemoveMergeExternalIssue: () => ({ mutateAsync: state.remove, isPending: false }),
}));

function detail(overrides: Partial<MergeIssueDetailDto> = {}): MergeIssueDetailDto {
  return { ...makeIssue(), external: null, recordLinks: [], pullRequests: [], subIssues: [], ...overrides };
}

function repo(overrides: Partial<MergeRepositoryDto> = {}): MergeRepositoryDto {
  return {
    id: 'mrp_1',
    connectionId: 'mcn_1',
    provider: 'github',
    externalId: '1',
    fullName: 'weldsuite/weldsuite',
    defaultBranch: 'develop',
    private: true,
    url: null,
    teamId: 'mtm_1',
    issueSync: 'two_way',
    prSync: true,
    externalProject: null,
    openPullRequestCount: 0,
    lastSyncedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const linked = {
  provider: 'github' as const,
  number: 412,
  url: 'https://github.com/weldsuite/weldsuite/issues/412',
  state: 'open' as const,
  repositoryId: 'mrp_1',
  repositoryFullName: 'weldsuite/weldsuite',
};

describe('IssueExternalSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.can = true;
    state.repositories = { isLoading: false, data: [repo()] };
    state.create.mockResolvedValue({});
    state.remove.mockResolvedValue(undefined);
  });

  it('shows the linked provider issue with its number, state and link', () => {
    render(<IssueExternalSync issue={detail({ external: linked })} />);
    expect(screen.getByText('weldsuite/weldsuite #412')).toBeTruthy();
    expect(screen.getByText(en.weldmerge.sync.externalSync.stateOpen)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open on GitHub/, hidden: false });
    expect(link.getAttribute('href')).toBe(linked.url);
  });

  it('stops syncing after a confirmation', async () => {
    render(<IssueExternalSync issue={detail({ external: linked })} />);
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.sync.externalSync.unlink }));
    fireEvent.click(await screen.findByRole('button', { name: en.weldmerge.sync.externalSync.unlink, hidden: false }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledTimes(1));
  });

  it('hides the unlink action from someone who cannot update issues', () => {
    state.can = false;
    render(<IssueExternalSync issue={detail({ external: { ...linked, state: 'closed' } })} />);
    expect(screen.getByText(en.weldmerge.sync.externalSync.stateClosed)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.weldmerge.sync.externalSync.unlink })).toBeNull();
  });

  it('creates the issue on the team repository that has two-way sync', async () => {
    state.repositories = { isLoading: false, data: [repo(), repo({ id: 'mrp_2', fullName: 'weldsuite/other', issueSync: 'import', teamId: null })] };
    render(<IssueExternalSync issue={detail()} />);
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.sync.externalSync.create }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith({ repositoryId: 'mrp_1' }));
  });

  it('says so when no repository has two-way sync', () => {
    state.repositories = { isLoading: false, data: [repo({ issueSync: 'import' })] };
    render(<IssueExternalSync issue={detail()} />);
    expect(screen.getByText(en.weldmerge.sync.externalSync.noRepositories)).toBeTruthy();
  });

  it('shows nothing to someone who cannot update an issue that is not linked', () => {
    state.can = false;
    const { container } = render(<IssueExternalSync issue={detail()} />);
    expect(container.textContent).toBe('');
  });
});
