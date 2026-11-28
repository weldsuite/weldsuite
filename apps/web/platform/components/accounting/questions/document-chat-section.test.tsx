import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({ questions: true }));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/edition')>();
  return {
    ...actual,
    isFeatureAvailable: (feature: Parameters<typeof actual.isFeatureAvailable>[0]) =>
      feature === 'books-questions' ? env.questions : actual.isFeatureAvailable(feature),
  };
});
vi.mock('./ask-question-button', () => ({
  AskQuestionButton: ({ recordType, recordId }: { recordType: string; recordId: string }) => (
    <button type="button" data-testid="document-ask-question" data-type={recordType} data-id={recordId}>
      Ask a question
    </button>
  ),
}));
vi.mock('./record-question-chat', () => ({
  RecordQuestionChat: ({ recordType, recordId }: { recordType: string; recordId: string }) => (
    <div data-testid="record-question-chat" data-type={recordType} data-id={recordId} />
  ),
}));

import { renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';
import { DocumentChatSection } from './document-chat-section';

beforeEach(() => {
  env.questions = true;
});

describe('the chat of an inbox document', () => {
  it('is closed at first: the ask action is there, the chat is not even loaded', () => {
    renderWithProviders(<DocumentChatSection documentId="doc_1" name="scan.pdf" />);
    expect(screen.getByTestId('document-ask-question')).toHaveAttribute('data-type', 'accounting_document');
    expect(screen.getByTestId('document-ask-question')).toHaveAttribute('data-id', 'doc_1');
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('record-question-chat')).not.toBeInTheDocument();
  });

  it('opens the document chat, and closes it again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DocumentChatSection documentId="doc_1" />);
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('record-question-chat')).toHaveAttribute('data-type', 'accounting_document');
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.queryByTestId('record-question-chat')).not.toBeInTheDocument();
  });

  it('is not there on Global', () => {
    env.questions = false;
    const { container } = renderWithProviders(<DocumentChatSection documentId="doc_1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
