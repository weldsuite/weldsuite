import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { MergeReleaseDto } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import WeldMergeReleasesPage from './page';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  can: true,
  releases: { isLoading: false, isError: false, data: [] as unknown[], refetch: vi.fn() },
  lastParams: undefined as unknown,
  repositories: { isSuccess: true, data: [{ id: 'mrp_1', fullName: 'acme/api', teamId: 'mtm_1' }] as unknown[] },
  teams: { data: [{ id: 'mtm_1', name: 'Platform', key: 'PLAT' }] as unknown[] },
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.can, useCanAny: () => state.can }));
vi.mock('@/hooks/queries/use-weldmerge-across-queries', () => ({
  useMergeReleases: (params: unknown) => {
    state.lastParams = params;
    return state.releases;
  },
  useCreateMergeRelease: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({
  useMergeRepositories: () => state.repositories,
  useMergeTeams: () => state.teams,
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: state.push }),
}));

function release(overrides: Partial<MergeReleaseDto> = {}): MergeReleaseDto {
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
    notes: null,
    notesGeneratedAt: null,
    knowledgePageId: null,
    shippedAt: null,
    pullRequestCount: 7,
    createdByUserId: 'user_1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('WeldMerge releases list', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.can = true;
    state.releases = { isLoading: false, isError: false, data: [], refetch: vi.fn() };
    state.repositories = { isSuccess: true, data: [{ id: 'mrp_1', fullName: 'acme/api', teamId: 'mtm_1' }] };
    state.teams = { data: [{ id: 'mtm_1', name: 'Platform', key: 'PLAT' }] };
    state.push = vi.fn();
  });

  it('lists releases with status and pull request count and opens one', () => {
    state.releases.data = [release(), release({ id: 'mrl_2', name: 'Winter release', status: 'shipped', pullRequestCount: 3 })];
    render(<WeldMergeReleasesPage />);
    expect(screen.getByRole('heading', { name: en.weldmerge.across.releases.title })).toBeTruthy();
    expect(screen.getByText('Spring release')).toBeTruthy();
    expect(screen.getByText('7 pull requests')).toBeTruthy();
    expect(screen.getAllByText(en.weldmerge.across.releases.status.shipped).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Winter release' }));
    expect(state.push).toHaveBeenCalledWith('/weldmerge/releases/mrl_2');
  });

  it('filters by status through the tabs', () => {
    render(<WeldMergeReleasesPage />);
    expect(state.lastParams).toEqual({});
    fireEvent.click(screen.getByRole('tab', { name: en.weldmerge.across.releases.tabs.draft }));
    expect(state.lastParams).toEqual({ status: 'draft' });
  });

  it('offers New release to managers only', () => {
    const { unmount } = render(<WeldMergeReleasesPage />);
    expect(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.releases.newRelease) })).toBeTruthy();
    unmount();
    state.can = false;
    render(<WeldMergeReleasesPage />);
    expect(screen.queryByRole('button', { name: new RegExp(en.weldmerge.across.releases.newRelease) })).toBeNull();
  });

  it('says so when no repository is added', () => {
    state.repositories = { isSuccess: true, data: [] };
    render(<WeldMergeReleasesPage />);
    expect(screen.getByText(en.weldmerge.across.releases.noRepositories)).toBeTruthy();
  });

  it('shows the error state with a retry', () => {
    state.releases = { isLoading: false, isError: true, data: [], refetch: vi.fn() };
    render(<WeldMergeReleasesPage />);
    expect(screen.getByText(en.weldmerge.across.releases.loadFailed)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.retry }));
    expect(state.releases.refetch).toHaveBeenCalled();
  });

  it('reads in Dutch', () => {
    state.locale = 'nl';
    state.releases.data = [release({ status: 'shipped' })];
    render(<WeldMergeReleasesPage />);
    expect(screen.getByRole('heading', { name: nl.weldmerge.across.releases.title })).toBeTruthy();
    expect(screen.getAllByText(nl.weldmerge.across.releases.status.shipped).length).toBeGreaterThan(0);
  });
});
