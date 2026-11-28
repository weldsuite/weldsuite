import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  questions: true,
  allowed: new Set<string>(['messages:create']),
  patch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/api/weldbooks-client', () => ({
  weldbooksApi: { get: vi.fn(), post: vi.fn(), patch: env.patch, delete: vi.fn() },
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

import { renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';
import { weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import { MessageQuestionBar, QuestionStatusChip, questionOfMessage } from './question-status';

const members = new Map([['user_mila', 'Mila Jansen']]);

const question = (status: string, askedTo: string[] = ['user_mila']) => ({
  id: 'msg_1',
  metadata: { question: { status, askedTo } },
  threadReplyCount: 1,
});

const updated = (status: string) => ({ data: { id: 'msg_1', channelId: 'ch_1', status, askedTo: [{ id: 'user_mila', name: 'Mila Jansen' }] } });

beforeEach(() => {
  env.questions = true;
  env.allowed = new Set(['messages:create']);
  env.patch.mockReset();
  env.toast.success.mockReset();
  env.toast.error.mockReset();
});

describe('questionOfMessage', () => {
  it('reads the status and who it was asked to from the thread starter', () => {
    expect(questionOfMessage(question('answered', ['u1', 'u2']))).toEqual({ status: 'answered', askedTo: ['u1', 'u2'] });
  });

  it('is nothing for an ordinary message or a reply', () => {
    expect(questionOfMessage({ metadata: null })).toBeNull();
    expect(questionOfMessage({ metadata: { anchor: { label: 'A1' } } })).toBeNull();
    expect(questionOfMessage({ ...question('open'), parentId: 'msg_0' })).toBeNull();
  });

  it('treats a status it does not know as open', () => {
    expect(questionOfMessage(question('mystery'))?.status).toBe('open');
  });
});

describe('the status chip', () => {
  it.each([
    ['open', 'Open'],
    ['answered', 'Answered'],
    ['resolved', 'Resolved'],
  ] as const)('says %s in words', (status, text) => {
    renderWithProviders(<QuestionStatusChip status={status} />);
    expect(screen.getByTestId('question-status')).toHaveTextContent(text);
    expect(screen.getByTestId('question-status')).toHaveAttribute('data-status', status);
  });
});

describe('the strip under a question', () => {
  it('shows the status, who it was asked to and "Mark resolved" for an open question', () => {
    renderWithProviders(<MessageQuestionBar message={question('open')} channelId="ch_1" membersMap={members} />);
    expect(screen.getByTestId('question-status')).toHaveTextContent('Open');
    expect(screen.getByText('Asked to Mila Jansen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark resolved' })).toBeInTheDocument();
  });

  it('says it was asked to the accountants when nobody was named', () => {
    renderWithProviders(<MessageQuestionBar message={question('open', [])} channelId="ch_1" />);
    expect(screen.getByText('Asked to your accountants')).toBeInTheDocument();
  });

  it('marks it resolved, and the chip changes at once in the thread', async () => {
    const user = userEvent.setup();
    env.patch.mockResolvedValue(updated('resolved'));
    const { client } = renderWithProviders(<MessageQuestionBar message={question('answered')} channelId="ch_1" membersMap={members} />);
    client.setQueryData(weldchatKeys.messages('ch_1'), {
      pages: [{ data: { messages: [{ id: 'msg_1', metadata: { question: { status: 'answered' } } }] } }],
      pageParams: [undefined],
    });
    await user.click(screen.getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(env.patch).toHaveBeenCalledWith('/accounting-questions/msg_1', { status: 'resolved' }));
    await waitFor(() => expect(env.toast.success).toHaveBeenCalledWith('Question updated'));
    const cached = client.getQueryData<{ pages: Array<{ data: { messages: Array<{ metadata: { question: { status: string } } }> } }> }>(
      weldchatKeys.messages('ch_1'),
    );
    expect(cached?.pages[0]?.data.messages[0]?.metadata.question.status).toBe('resolved');
  });

  it('offers "Re-open" for a resolved question and asks for it again', async () => {
    const user = userEvent.setup();
    env.patch.mockResolvedValue(updated('open'));
    renderWithProviders(<MessageQuestionBar message={question('resolved')} channelId="ch_1" membersMap={members} />);
    expect(screen.queryByRole('button', { name: 'Mark resolved' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Re-open' }));
    await waitFor(() => expect(env.patch).toHaveBeenCalledWith('/accounting-questions/msg_1', { status: 'open' }));
  });

  it('says so when the change failed', async () => {
    const user = userEvent.setup();
    env.patch.mockRejectedValue(new Error('Forbidden'));
    renderWithProviders(<MessageQuestionBar message={question('open')} channelId="ch_1" />);
    await user.click(screen.getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('The question could not be updated', { description: 'Forbidden' }));
  });

  it('leaves the actions out for a member who may not write, but still shows the status', () => {
    env.allowed = new Set();
    renderWithProviders(<MessageQuestionBar message={question('open')} channelId="ch_1" />);
    expect(screen.getByTestId('question-status')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing for an ordinary message', () => {
    const { container } = renderWithProviders(<MessageQuestionBar message={{ id: 'msg_2', metadata: null }} channelId="ch_1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on Global, whatever the message carries', () => {
    env.questions = false;
    const { container } = renderWithProviders(<MessageQuestionBar message={question('open')} channelId="ch_1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
