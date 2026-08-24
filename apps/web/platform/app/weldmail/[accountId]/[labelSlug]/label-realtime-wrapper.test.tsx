import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LabelRealtimeWrapper } from './label-realtime-wrapper';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      mail: {
        splitLayout: {
          connecting: 'Connecting...',
          // Intentionally still defined so a regression that re-renders the
          // pill would surface as visible text in the assertion below.
          newEmails: '{count} new',
        },
      },
    },
  }),
}));

vi.mock('@/lib/router', () => ({
  useParams: () => ({}),
}));

vi.mock('../../hooks/useMailRealtime', () => ({
  useMailRealtime: () => ({
    connectionStatus: 'connected',
    newEmailCount: 3,
    resetNewEmailCount: vi.fn(),
    isConnected: true,
    reconnect: vi.fn(),
  }),
}));

vi.mock('../../components/message-list', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

describe('LabelRealtimeWrapper', () => {
  it('does not show the floating "N new" pill when realtime reports new mail', () => {
    render(
      <LabelRealtimeWrapper
        initialThreads={[]}
        accountId="macc_test"
        labelSlug="inbox"
        displayName="Inbox"
        error={null}
        currentPage={1}
        totalPages={1}
        totalCount={0}
        pageSize={25}
      />,
    );

    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.queryByText(/3 new/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new/i })).not.toBeInTheDocument();
  });
});
