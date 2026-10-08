import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import WeldKnowIndexPage from './page';

type TreeNode = { id: string; updatedAt: string };

let spaces: { id: string }[] = [];
let tree: TreeNode[] | undefined;
let treeFetching = false;
let spacesLoading = false;

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ params }: { params: { pageId: string } }) => <div>redirect:{params.pageId}</div>,
}));

vi.mock('@weldsuite/permissions/react', () => ({
  useCan: () => true,
}));

vi.mock('@/hooks/queries/use-knowledge-queries', () => ({
  useKnowledgeSpaces: () => ({ data: { data: spaces }, isLoading: spacesLoading }),
  useKnowledgePageTree: () => ({ data: tree ? { data: tree } : undefined, isFetching: treeFetching }),
}));

vi.mock('@/components/page-loader', () => ({
  PageLoader: () => <div>loading</div>,
}));

vi.mock('./components/create-space-dialog', () => ({
  CreateSpaceDialog: () => null,
}));

describe('WeldKnow index page', () => {
  beforeEach(() => {
    spaces = [{ id: 'ks_1' }];
    tree = [];
    treeFetching = false;
    spacesLoading = false;
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

  it('shows the select-a-page hint when there are spaces but no pages', () => {
    render(<WeldKnowIndexPage />);

    expect(screen.getByText(en.weldknow.emptyState.selectPageTitle)).toBeTruthy();
  });

  it('offers to create the first teamspace when there are none', () => {
    spaces = [];
    render(<WeldKnowIndexPage />);

    expect(screen.getByText(en.weldknow.emptyState.noAccessTitle)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.weldknow.sidebar.createSpace })).toBeTruthy();
  });
});
