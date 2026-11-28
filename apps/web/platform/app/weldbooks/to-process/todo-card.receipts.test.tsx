import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { TodoItem } from '@/lib/api/domains/weldbooks';

const env = vi.hoisted(() => ({
  questions: true,
  allowed: new Set<string>(['journal:create', 'messages:create']),
  items: [] as unknown[],
  post: vi.fn(),
}));

vi.mock('@/lib/api/weldbooks-client', () => ({
  weldbooksApi: { get: vi.fn(), post: env.post, patch: vi.fn(), delete: vi.fn() },
  setWeldbooksEntityId: vi.fn(),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  useCan: (permission: string) => env.allowed.has(permission),
  usePermissions: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/lib/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/edition')>();
  return {
    ...actual,
    isFeatureAvailable: (feature: Parameters<typeof actual.isFeatureAvailable>[0]) =>
      feature === 'books-questions' ? env.questions : actual.isFeatureAvailable(feature),
  };
});
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ stack: [], open: vi.fn() }) }));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined) => `€${value}`,
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-todo-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-weldbooks-todo-queries')>()),
  TODO_TOP_LIMIT: 3,
  useTodoTopItems: () => ({ data: env.items.slice(0, 3), isError: false, refetch: vi.fn() }),
  useInfiniteTodoItems: () => ({
    data: { items: env.items, totalCount: env.items.length },
    isError: false,
    refetch: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));

import { renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';
import { TodoCard } from './todo-card';

const line = (id: string, title: string): TodoItem => ({
  kind: 'missing_receipts',
  objectType: 'bank_transaction',
  objectId: id,
  title,
  subtitle: null,
  amount: '25.00',
  currency: 'EUR',
  date: '2026-11-04',
  dueDate: null,
  severity: 'info',
  hint: 'missing_receipt',
});

const renderCard = () => renderWithProviders(<TodoCard kind="missing_receipts" summary={{ count: 4, amount: null }} />);

beforeEach(() => {
  env.questions = true;
  env.allowed = new Set(['journal:create', 'messages:create']);
  env.items = [line('btx_1', 'J. Bakker'), line('btx_2', 'Coffee Co'), line('btx_3', 'Taxi BV'), line('btx_4', 'Hosting Ltd')];
  env.post.mockReset();
});

describe('Missing receipts: ask for receipts', () => {
  it('lets an accountant pick lines and ask about all of them at once, with a summary of the result', async () => {
    const user = userEvent.setup();
    env.post.mockResolvedValue({
      data: {
        created: [{ id: 'q1' }, { id: 'q2' }],
        failed: [{ recordId: 'btx_4', status: 403, error: 'You cannot open this record' }],
      },
    });
    renderCard();
    // Only the first three lines are listed until picking starts.
    expect(screen.getAllByTestId('todo-item')).toHaveLength(3);
    await user.click(screen.getByTestId('todo-ask-receipts'));
    // Every line can be picked, not only the first three.
    expect(screen.getAllByTestId('todo-item')).toHaveLength(4);
    expect(screen.getByTestId('todo-receipts-ask')).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Select J. Bakker' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Taxi BV' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Hosting Ltd' }));
    expect(screen.getByTestId('todo-receipts-count')).toHaveTextContent('3 lines selected');

    await user.click(screen.getByTestId('todo-receipts-ask'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Your question')).toHaveValue('Could you add the receipt for this payment?');
    await user.click(within(dialog).getByTestId('receipts-submit'));

    await waitFor(() =>
      expect(env.post).toHaveBeenCalledWith('/accounting-questions/bulk', {
        recordType: 'bank_transaction',
        recordIds: ['btx_1', 'btx_3', 'btx_4'],
        text: 'Could you add the receipt for this payment?',
      }),
    );
    const result = await within(dialog).findByTestId('receipts-result');
    expect(result).toHaveTextContent('Asked about 2 bank lines.');
    expect(within(result).getByTestId('receipts-failed')).toHaveTextContent('1 line could not be asked about:');
    expect(within(result).getByTestId('receipts-failed')).toHaveTextContent('Hosting Ltd: You cannot open this record');
    // The selection is cleared once the questions are sent.
    await waitFor(() => expect(screen.queryByTestId('todo-receipts-count')).not.toBeInTheDocument());
  });

  it('asks one line in the singular', async () => {
    const user = userEvent.setup();
    env.post.mockResolvedValue({ data: { created: [{ id: 'q1' }], failed: [] } });
    renderCard();
    await user.click(screen.getByTestId('todo-ask-receipts'));
    await user.click(screen.getByRole('checkbox', { name: 'Select Coffee Co' }));
    expect(screen.getByTestId('todo-receipts-count')).toHaveTextContent('1 line selected');
    await user.click(screen.getByTestId('todo-receipts-ask'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('One question goes to the chat of the selected bank line.');
    await user.click(within(dialog).getByTestId('receipts-submit'));
    expect(await within(dialog).findByTestId('receipts-result')).toHaveTextContent('Asked about 1 bank line.');
    expect(screen.queryByTestId('receipts-failed')).not.toBeInTheDocument();
  });

  it('cancels picking without asking', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByTestId('todo-ask-receipts'));
    await user.click(screen.getByRole('checkbox', { name: 'Select Coffee Co' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(env.post).not.toHaveBeenCalled();
  });

  it('is for accountants only: an owner (no journal:create) does not see it', () => {
    env.allowed = new Set(['messages:create']);
    renderCard();
    expect(screen.queryByTestId('todo-ask-receipts')).not.toBeInTheDocument();
  });

  it('needs the permission to write in a chat', () => {
    env.allowed = new Set(['journal:create']);
    renderCard();
    expect(screen.queryByTestId('todo-ask-receipts')).not.toBeInTheDocument();
  });

  it('is not there on Global', () => {
    env.questions = false;
    renderCard();
    expect(screen.queryByTestId('todo-ask-receipts')).not.toBeInTheDocument();
  });

  it('is on no other card', () => {
    renderWithProviders(<TodoCard kind="bank_lines" summary={{ count: 4, amount: null }} />);
    expect(screen.queryByTestId('todo-ask-receipts')).not.toBeInTheDocument();
  });
});
