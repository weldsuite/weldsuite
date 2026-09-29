import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiError } from '@weldsuite/api-client';
import ArticleEditPage from './page';

const replace = vi.fn();
const push = vi.fn();

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push, replace }),
  useParams: () => ({ id: 'art_123' }),
}));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));

vi.mock('@/components/page-loader', () => ({
  PageLoader: () => <div data-testid="page-loader" />,
}));

vi.mock('../article-editor', () => ({
  ArticleEditor: ({ article }: { article: { title: string } }) => (
    <div data-testid="article-editor">{article.title}</div>
  ),
}));

interface QueryState {
  data: { data: Record<string, unknown> } | undefined;
  isPending: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

let queryState: QueryState;

vi.mock('@/hooks/queries/use-helpdesk-queries', () => ({
  useArticle: () => queryState,
}));

const article = {
  id: 'art_123',
  title: 'How to reset your password',
  content: '<p>Steps</p>',
  status: 'draft',
  visibility: 'public',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

describe('ArticleEditPage', () => {
  beforeEach(() => {
    replace.mockClear();
    push.mockClear();
  });

  it('does not navigate away while the query has not started (reload / direct open)', () => {
    // A disabled query, or one waiting for the persisted cache to restore, is
    // pending but not loading. This used to be read as "article not found".
    queryState = { data: undefined, isPending: true, isLoading: false, isError: false, error: null };

    render(<ArticleEditPage />);

    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId('page-loader')).toBeTruthy();
    expect(screen.queryByTestId('article-editor')).toBeNull();
  });

  it('does not navigate away while the request is in flight', () => {
    queryState = { data: undefined, isPending: true, isLoading: true, isError: false, error: null };

    render(<ArticleEditPage />);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('page-loader')).toBeTruthy();
  });

  it('opens the editor once the article has loaded', () => {
    queryState = { data: { data: article }, isPending: false, isLoading: false, isError: false, error: null };

    render(<ArticleEditPage />);

    expect(screen.getByTestId('article-editor').textContent).toBe('How to reset your password');
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects to the list when the article really does not exist (404)', () => {
    queryState = {
      data: undefined,
      isPending: false,
      isLoading: false,
      isError: true,
      error: new ApiError('Article not found', 404),
    };

    render(<ArticleEditPage />);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/welddesk/help-center/articles');
  });

  it('redirects when the request succeeds but returns no article', () => {
    queryState = { data: undefined, isPending: false, isLoading: false, isError: false, error: null };

    render(<ArticleEditPage />);

    expect(replace).toHaveBeenCalledWith('/welddesk/help-center/articles');
  });

  it('stays on the page and shows an error for a non-404 failure', () => {
    queryState = {
      data: undefined,
      isPending: false,
      isLoading: false,
      isError: true,
      error: new ApiError('Internal error', 500),
    };

    render(<ArticleEditPage />);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText('common.toast.failedToLoad')).toBeTruthy();
  });
});
