import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import WeldKnowIndexPage from './page';

type TreeNode = { id: string; updatedAt: string };
type Space = { id: string; kind: 'personal' | 'team'; canWrite: boolean };

let spaces: Space[] = [];
let tree: TreeNode[] | undefined;
let treeFetching = false;
let spacesLoading = false;
const createPage = vi.fn();
const push = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ params }: { params: { pageId: string } }) => <div>redirect:{params.pageId}</div>,
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  useCan: () => true,
}));

vi.mock('@/hooks/queries/use-knowledge-queries', () => ({
  useKnowledgeSpaces: () => ({ data: { data: spaces }, isLoading: spacesLoading }),
  useKnowledgePageTree: () => ({ data: tree ? { data: tree } : undefined, isFetching: treeFetching }),
  useCreateKnowledgePage: () => ({ mutateAsync: createPage, isPending: false }),
}));

vi.mock('@weldsuite/ui/components/page-loader', () => ({
  PageLoader: () => <div>loading</div>,
}));

vi.mock('./components/create-space-dialog', () => ({
  CreateSpaceDialog: () => null,
}));

describe('WeldKnow index page', () => {
  beforeEach(() => {
    spaces = [
      { id: 'ks_team', kind: 'team', canWrite: true },
      { id: 'ks_private', kind: 'personal', canWrite: true },
    ];
    tree = [];
    treeFetching = false;
    spacesLoading = false;
    createPage.mockReset();
    push.mockReset();
  });

  it('opens the most recently updated page', () => {
    tree = [
      { id: 'kp_old', updatedAt: '2026-01-01T10:00:00.000Z' },
      { id: 'kp_new', updatedAt: '2026-03-01T10:00:00.000Z' },
      { id: 'kp_mid', updatedAt: '2026-02-01T10:00:00.000Z' },
    ];
    render(<WeldKnowIndexPage />);

    expect(screen.getByText('redirect:kp_new')).toBeTruthy();
  });

  it('waits for a refetching tree instead of redirecting to a stale page', () => {
    tree = [{ id: 'kp_deleted', updatedAt: '2026-03-01T10:00:00.000Z' }];
    treeFetching = true;
    render(<WeldKnowIndexPage />);

    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.queryByText('redirect:kp_deleted')).toBeNull();
  });

  it('offers to write the first page, in the private space, when there are spaces but no pages', async () => {
    createPage.mockResolvedValue({ data: { id: 'kp_first' } });
    render(<WeldKnowIndexPage />);

    // Not "select a page": the sidebar has none to select.
    expect(screen.queryByText(en.weldknow.emptyState.selectPageTitle)).toBeNull();
    expect(screen.getByText(en.weldknow.emptyState.noPagesTitle)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en.weldknow.emptyState.createPage }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/weldknow/page/kp_first'));
    expect(createPage).toHaveBeenCalledWith({ spaceId: 'ks_private', parentId: null });
  });

  it('offers no page button when the caller can write in no space', () => {
    spaces = [{ id: 'ks_team', kind: 'team', canWrite: false }];
    render(<WeldKnowIndexPage />);

    expect(screen.getByText(en.weldknow.emptyState.noPagesTitle)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.weldknow.emptyState.createPage })).toBeNull();
  });

  it('offers to create the first teamspace when there are none', () => {
    spaces = [];
    render(<WeldKnowIndexPage />);

    expect(screen.getByText(en.weldknow.emptyState.noAccessTitle)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.weldknow.sidebar.createSpace })).toBeTruthy();
  });
});
