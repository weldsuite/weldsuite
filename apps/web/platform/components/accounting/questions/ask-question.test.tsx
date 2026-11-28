import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { BOOKS_RECORD_CHAT_TYPES } from '@weldsuite/app-api-client/schemas/chat-entity-channels';

const env = vi.hoisted(() => ({
  questions: true,
  allowed: new Set<string>(['messages:create']),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  members: [
    { userId: 'user_mila', name: 'Mila Jansen' },
    { userId: 'user_sam', name: 'Sam de Vries' },
  ],
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/api/weldbooks-client', () => ({
  weldbooksApi: { get: vi.fn(), post: env.post, patch: vi.fn(), delete: vi.fn() },
  setWeldbooksEntityId: vi.fn(),
}));
vi.mock('@weldsuite/permissions/react', () => ({
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
vi.mock('@/hooks/queries/use-weldchat-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-weldchat-queries')>()),
  useWorkspaceMembers: () => ({ data: { data: env.members } }),
}));
vi.mock('@/components/entity-chat/entity-chat', () => ({
  EntityChat: ({ entityType, entityId, headerSlot }: { entityType: string; entityId: string; headerSlot?: ReactNode }) => (
    <div data-testid="entity-chat" data-type={entityType} data-id={entityId}>
      {headerSlot}
    </div>
  ),
}));

import { renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';
import { AskQuestionButton } from './ask-question-button';
import { RecordQuestionChat } from './record-question-chat';

const asked = (overrides: Record<string, unknown> = {}) => ({
  data: { id: 'msg_1', channelId: 'ch_1', createdChannel: true, recordType: 'invoice', recordId: 'inv_1', ...overrides },
});

beforeEach(() => {
  env.questions = true;
  env.allowed = new Set(['messages:create']);
  env.post.mockReset();
  env.post.mockResolvedValue(asked());
  env.toast.success.mockReset();
  env.toast.error.mockReset();
});

describe('Ask a question', () => {
  it('asks the accountants by default: no one is named in the request', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AskQuestionButton recordType="invoice" recordId="inv_1" />);
    await user.click(screen.getByRole('button', { name: 'Ask a question' }));
    expect(screen.getByRole('heading', { name: 'Ask your accountant' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your question'), 'Is this the right VAT rate?');
    await user.click(screen.getByTestId('ask-submit'));
    await waitFor(() =>
      expect(env.post).toHaveBeenCalledWith('/accounting-questions', {
        recordType: 'invoice',
        recordId: 'inv_1',
        text: 'Is this the right VAT rate?',
        askedTo: undefined,
      }),
    );
    await waitFor(() => expect(env.toast.success).toHaveBeenCalledWith('Question sent'));
    // The dialog closes once the question is sent.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ask your accountant' })).not.toBeInTheDocument());
  });

  it('asks the people that were picked, and only them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AskQuestionButton recordType="bill" recordId="bil_1" />);
    await user.click(screen.getByRole('button', { name: 'Ask a question' }));
    await user.type(screen.getByLabelText('Your question'), 'Who approved this?');
    await user.click(screen.getByLabelText(/Choose people/));
    await user.click(screen.getByRole('checkbox', { name: 'Sam de Vries' }));
    await user.click(screen.getByTestId('ask-submit'));
    await waitFor(() =>
      expect(env.post).toHaveBeenCalledWith('/accounting-questions', {
        recordType: 'bill',
        recordId: 'bil_1',
        text: 'Who approved this?',
        askedTo: ['user_sam'],
      }),
    );
  });

  it('asks for a question and for at least one person when people are chosen, without calling the server', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AskQuestionButton recordType="vat_return" recordId="vat_1" />);
    await user.click(screen.getByRole('button', { name: 'Ask a question' }));
    await user.click(screen.getByTestId('ask-submit'));
    expect(await screen.findByText('Write your question first.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your question'), 'Check box 5b?');
    await user.click(screen.getByLabelText(/Choose people/));
    await user.click(screen.getByTestId('ask-submit'));
    expect(await screen.findByText('Tick at least one person, or ask your accountants.')).toBeInTheDocument();
    expect(env.post).not.toHaveBeenCalled();
  });

  it('says why the server refused, and keeps the form', async () => {
    const user = userEvent.setup();
    env.post.mockRejectedValue(new Error('One of the asked members cannot open this record'));
    renderWithProviders(<AskQuestionButton recordType="accounting_contact" recordId="prt_1" defaultText="Who is this?" />);
    await user.click(screen.getByRole('button', { name: 'Ask a question' }));
    expect(screen.getByLabelText('Your question')).toHaveValue('Who is this?');
    await user.click(screen.getByTestId('ask-submit'));
    expect(await screen.findByTestId('ask-error')).toHaveTextContent('One of the asked members cannot open this record');
    expect(screen.getByLabelText('Your question')).toHaveValue('Who is this?');
  });

  it.each(BOOKS_RECORD_CHAT_TYPES)('asks about a %s with that type', async (recordType) => {
    const user = userEvent.setup();
    renderWithProviders(<AskQuestionButton recordType={recordType} recordId="rec_1" defaultText="What is this?" />);
    await user.click(screen.getByRole('button', { name: 'Ask a question' }));
    await user.click(screen.getByTestId('ask-submit'));
    await waitFor(() =>
      expect(env.post).toHaveBeenCalledWith('/accounting-questions', expect.objectContaining({ recordType, recordId: 'rec_1' })),
    );
  });

  it('is not offered on Global, which has no questions', () => {
    env.questions = false;
    renderWithProviders(<AskQuestionButton recordType="invoice" recordId="inv_1" />);
    expect(screen.queryByRole('button', { name: 'Ask a question' })).not.toBeInTheDocument();
  });

  it('is not offered to a member who may not write in chats', () => {
    env.allowed = new Set();
    renderWithProviders(<AskQuestionButton recordType="invoice" recordId="inv_1" />);
    expect(screen.queryByRole('button', { name: 'Ask a question' })).not.toBeInTheDocument();
  });
});

describe('the Chat tab of a record', () => {
  it.each(BOOKS_RECORD_CHAT_TYPES)('is the chat of the %s, with the ask action above it', (recordType) => {
    renderWithProviders(<RecordQuestionChat recordType={recordType} recordId="rec_1" name="Record" />);
    const chat = screen.getByTestId('entity-chat');
    expect(chat).toHaveAttribute('data-type', recordType);
    expect(chat).toHaveAttribute('data-id', 'rec_1');
    expect(screen.getByTestId('chat-ask-question')).toBeInTheDocument();
  });

  it('has no ask action without the permission, but still shows the chat', () => {
    env.allowed = new Set();
    renderWithProviders(<RecordQuestionChat recordType="invoice" recordId="inv_1" />);
    expect(screen.getByTestId('entity-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-ask-question')).not.toBeInTheDocument();
  });
});
