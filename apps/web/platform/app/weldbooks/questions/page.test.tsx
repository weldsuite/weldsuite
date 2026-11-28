import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Question } from '@/lib/api/domains/weldbooks-questions';

const env = vi.hoisted(() => ({
  available: true,
  allowed: new Set<string>(),
  search: {} as Record<string, string>,
  navigate: vi.fn(),
  open: vi.fn(),
  push: vi.fn(),
  questions: [] as unknown[],
  filters: [] as unknown[],
  loading: false,
  isError: false,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  total: 0,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => env.navigate,
  useSearch: () => env.search,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/components/edition-unavailable-page', () => ({ EditionUnavailablePage: () => <p>unavailable</p> }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ stack: [], open: env.open }),
  useObjectPanelUrlSync: vi.fn(),
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatDate: (value: string) => `date:${value}` }),
}));
vi.mock('@/hooks/queries/use-weldbooks-questions-queries', () => ({
  isQuestionsAvailable: () => env.available,
  useInfiniteQuestions: (filters: unknown) => {
    env.filters.push(filters);
    return {
      data: env.loading ? undefined : { items: env.questions, totalCount: env.total || env.questions.length },
      isError: env.isError,
      hasNextPage: env.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: env.fetchNextPage,
      refetch: env.refetch,
    };
  },
}));

import { polyfillRadixSelect, renderWithProviders } from '../banking/components/test-utils';
import QuestionsPage, { questionFilters } from './page';

const question = (overrides: Partial<Question> = {}): Question => ({
  id: 'msg_1',
  recordType: 'bill',
  recordId: 'bil_1',
  recordTitle: 'Hosting Ltd',
  text: 'Is this bill for the new office?',
  status: 'open',
  askedBy: { id: 'user_mila', name: 'Mila Jansen' },
  askedTo: [],
  createdAt: '2026-11-04',
  lastReplyAt: null,
  replyCount: 0,
  entityId: 'ent_1',
  channelId: 'ch_1',
  link: null,
  ...overrides,
});

beforeEach(() => {
  polyfillRadixSelect();
  env.available = true;
  env.allowed = new Set();
  env.search = {};
  env.questions = [question()];
  env.filters = [];
  env.loading = false;
  env.isError = false;
  env.hasNextPage = false;
  env.total = 0;
  env.navigate.mockReset();
  env.open.mockReset();
  env.push.mockReset();
  env.fetchNextPage.mockReset();
  env.refetch.mockReset();
});

describe('questionFilters', () => {
  it('starts with the open questions asked to me, and every open question for someone who books', () => {
    expect(questionFilters({}, false)).toEqual({ status: 'open', askedTo: 'me', recordType: undefined });
    expect(questionFilters({}, true)).toEqual({ status: 'open', askedTo: 'any', recordType: undefined });
  });

  it('reads the filters of the address, and ignores what it does not know', () => {
    expect(questionFilters({ status: 'resolved', askedTo: 'any', type: 'invoice' }, false)).toEqual({
      status: 'resolved',
      askedTo: 'any',
      recordType: 'invoice',
    });
    expect(questionFilters({ status: 'all' }, false).status).toBeUndefined();
    expect(questionFilters({ status: 'weird', askedTo: 'nobody', type: 'spaceship' }, false)).toEqual({
      status: 'open',
      askedTo: 'me',
      recordType: undefined,
    });
  });
});

describe('the Questions list', () => {
  it('lists each question with its status, the record, who asked and when', () => {
    env.questions = [question({ replyCount: 2, status: 'answered' })];
    renderWithProviders(<QuestionsPage />);
    expect(screen.getByRole('heading', { name: 'Questions' })).toBeInTheDocument();
    expect(screen.getByTestId('questions-count')).toHaveTextContent('1 question');
    const row = screen.getByTestId('question-list-row');
    expect(within(row).getByTestId('question-status')).toHaveTextContent('Answered');
    expect(row).toHaveTextContent('bill · Hosting Ltd');
    expect(row).toHaveTextContent('Asked by Mila Jansen · date:2026-11-04 · 2 replies');
    expect(within(row).getByText('Is this bill for the new office?')).toBeInTheDocument();
  });

  it('opens the record on its Chat tab from the row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QuestionsPage />);
    await user.click(screen.getByTestId('question-list-open'));
    expect(env.open).toHaveBeenCalledWith({ type: 'bill', id: 'bil_1', initialTab: 'chat', stack: true });
    await user.click(screen.getByRole('button', { name: 'Open the chat' }));
    expect(env.open).toHaveBeenCalledTimes(2);
  });

  it('opens the documents page for a question on an inbox document', async () => {
    const user = userEvent.setup();
    env.questions = [question({ recordType: 'accounting_document', recordId: 'doc_1', recordTitle: 'scan.pdf' })];
    renderWithProviders(<QuestionsPage />);
    await user.click(screen.getByRole('button', { name: 'Open the chat' }));
    expect(env.push).toHaveBeenCalledWith('/weldbooks/documents?document=doc_1');
  });

  it('asks the server for what the address says', () => {
    env.search = { status: 'answered', askedTo: 'any', type: 'bank_transaction' };
    renderWithProviders(<QuestionsPage />);
    expect(env.filters.at(-1)).toEqual({ status: 'answered', askedTo: 'any', recordType: 'bank_transaction' });
  });

  it('keeps the other parameters of the address (the stacked panel) when a filter changes', async () => {
    const user = userEvent.setup();
    env.search = { stack: 'bill:bil_1' };
    renderWithProviders(<QuestionsPage />);
    await user.click(within(screen.getByTestId('questions-filters')).getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Resolved' }));
    expect(env.navigate).toHaveBeenCalledWith({ to: '/weldbooks/questions', search: { stack: 'bill:bil_1', status: 'resolved' } });
  });

  it('pages: Load more asks for the next page', async () => {
    const user = userEvent.setup();
    env.hasNextPage = true;
    env.total = 40;
    renderWithProviders(<QuestionsPage />);
    expect(screen.getByTestId('questions-count')).toHaveTextContent('40 questions');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(env.fetchNextPage).toHaveBeenCalled();
  });

  it('says there are none', () => {
    env.questions = [];
    renderWithProviders(<QuestionsPage />);
    expect(screen.getByText('No questions')).toBeInTheDocument();
  });

  it('says so when the questions could not be loaded, and tries again', async () => {
    const user = userEvent.setup();
    env.loading = true;
    env.isError = true;
    renderWithProviders(<QuestionsPage />);
    expect(screen.getByText('The questions could not be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('is the "not available" page on Global', () => {
    env.available = false;
    renderWithProviders(<QuestionsPage />);
    expect(screen.getByText('unavailable')).toBeInTheDocument();
  });
});
