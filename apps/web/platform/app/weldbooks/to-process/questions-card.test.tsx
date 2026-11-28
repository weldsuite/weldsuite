import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { Question } from '@/lib/api/domains/weldbooks-questions';

const env = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  allowed: new Set<string>(),
  questions: [] as unknown[],
  filters: [] as unknown[],
  isError: false,
  loading: false,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  open: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: env.locale === 'nl' ? dutch : english, language: env.locale }) };
});
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: env.push }),
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ stack: [], open: env.open }) }));
vi.mock('@/hooks/use-member-avatar', () => ({ useMemberAvatar: () => undefined }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatDate: (value: string) => `date:${value}` }),
}));
vi.mock('@/hooks/queries/use-weldbooks-todo-queries', () => ({ TODO_TOP_LIMIT: 3 }));
vi.mock('@/hooks/queries/use-weldbooks-questions-queries', () => ({
  useInfiniteQuestions: (filters: unknown) => {
    env.filters.push(filters);
    return {
      data: env.loading ? undefined : { items: env.questions, totalCount: env.questions.length },
      isError: env.isError,
      hasNextPage: env.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: env.fetchNextPage,
      refetch: env.refetch,
    };
  },
}));

import { QuestionsCard, initialsOf } from './questions-card';

const question = (overrides: Partial<Question> = {}): Question => ({
  id: 'msg_1',
  recordType: 'bank_transaction',
  recordId: 'btx_1',
  recordTitle: '−€640.00 · J. Bakker',
  text: "What was this payment for? If it's a refund to a customer, add the credit note.",
  status: 'open',
  askedBy: { id: 'user_mila', name: 'Mila Jansen' },
  askedTo: [{ id: 'user_owner', name: 'Owner' }],
  createdAt: '2026-11-04',
  lastReplyAt: null,
  replyCount: 0,
  entityId: 'ent_1',
  channelId: 'ch_1',
  link: '/weldbooks/banking/transactions?stack=bank_transaction:btx_1',
  ...overrides,
});

beforeEach(() => {
  env.locale = 'en';
  env.allowed = new Set();
  env.questions = [question()];
  env.filters = [];
  env.isError = false;
  env.loading = false;
  env.hasNextPage = false;
  env.open.mockReset();
  env.push.mockReset();
  env.fetchNextPage.mockReset();
  env.refetch.mockReset();
});

const renderCard = (count = 1) => render(<QuestionsCard summary={{ count, amount: null }} />);

describe('initialsOf', () => {
  it('takes the first and last initial', () => {
    expect(initialsOf('Mila Jansen')).toBe('MJ');
    expect(initialsOf('Mila van der Jansen')).toBe('MJ');
    expect(initialsOf('mila')).toBe('M');
    expect(initialsOf('')).toBe('?');
    expect(initialsOf(null)).toBe('?');
  });
});

describe('the Questions card', () => {
  it('follows the design: avatar, who asked, what it is about, the text, and the two actions', () => {
    renderCard();
    const card = screen.getByTestId('todo-card-questions');
    expect(within(card).getByRole('heading', { name: 'Questions from your accountant' })).toBeInTheDocument();
    expect(within(card).getByText('On the record they are about')).toBeInTheDocument();
    expect(within(card).getByTestId('todo-count')).toHaveTextContent('1');
    const row = within(card).getByTestId('question-row');
    expect(within(row).getByTestId('question-avatar')).toHaveTextContent('MJ');
    expect(row).toHaveTextContent('Mila Jansen · on bank line · −€640.00 · J. Bakker · date:2026-11-04');
    expect(within(row).getByText(/What was this payment for\?/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Answer' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Add a document' })).toBeInTheDocument();
  });

  it('answers in the record chat: the panel opens stacked on its Chat tab', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'bank_transaction', id: 'btx_1', initialTab: 'chat', stack: true });
  });

  it('adds a document in the processing view for that bank line', () => {
    renderCard();
    expect(screen.getByRole('link', { name: 'Add a document' })).toHaveAttribute(
      'href',
      '/weldbooks/banking/process?lineId=btx_1&action=receipt',
    );
  });

  it.each([
    ['invoice', 'invoice'],
    ['bill', 'bill'],
    ['vat_return', 'vat_return'],
    ['accounting_contact', 'weldbooks_contact'],
  ] as const)('answers a question on a %s in its panel, without "Add a document"', async (recordType, type) => {
    const user = userEvent.setup();
    env.questions = [question({ recordType, recordId: 'rec_1', recordTitle: 'Acme' })];
    renderCard();
    expect(screen.queryByRole('link', { name: 'Add a document' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(env.open).toHaveBeenCalledWith({ type, id: 'rec_1', initialTab: 'chat', stack: true });
  });

  it('answers a question on an inbox document on the documents page', async () => {
    const user = userEvent.setup();
    env.questions = [question({ recordType: 'accounting_document', recordId: 'doc 1', recordTitle: 'scan.pdf' })];
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(env.push).toHaveBeenCalledWith('/weldbooks/documents?document=doc%201');
    expect(env.open).not.toHaveBeenCalled();
  });

  it('asks for the open questions asked to an owner, and for every open one of the entity for an accountant', () => {
    renderCard();
    expect(env.filters.at(-1)).toEqual({ status: 'open', askedTo: 'me' });
    env.allowed = new Set(['journal:create']);
    renderCard();
    expect(env.filters.at(-1)).toEqual({ status: 'open', askedTo: 'any' });
  });

  it('shows the first three questions, and the rest with Show all', async () => {
    const user = userEvent.setup();
    env.questions = ['a', 'b', 'c', 'd', 'e'].map((id) => question({ id: `msg_${id}`, recordId: `btx_${id}` }));
    renderCard(5);
    expect(screen.getAllByTestId('question-row')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: /Show all 5/ }));
    expect(screen.getAllByTestId('question-row')).toHaveLength(5);
  });

  it('links to the list of all questions', () => {
    renderCard();
    expect(screen.getByRole('link', { name: 'All questions' })).toHaveAttribute('href', '/weldbooks/questions');
  });

  it('says so when the questions could not be loaded, and tries again', async () => {
    const user = userEvent.setup();
    env.loading = true;
    env.isError = true;
    renderCard();
    expect(screen.getByText(en.weldbooksConnected.todo.listFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('speaks Dutch', () => {
    env.locale = 'nl';
    renderCard();
    expect(screen.getByRole('heading', { name: nl.weldbooksConnected.todo.kinds.questions.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beantwoord' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voeg een document toe' })).toBeInTheDocument();
  });
});
