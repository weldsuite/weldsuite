import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MailSubscription } from '@weldsuite/app-api-client';
import { UnsubscribeSenderButton } from './unsubscribe-sender-button';

const state = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
  open: vi.fn(),
}));

vi.mock('@/hooks/queries/use-mail-queries', () => ({
  useUnsubscribeMailSubscription: () => ({ mutateAsync: state.mutateAsync, isPending: false }),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/i18n/provider')>('@weldsuite/i18n/provider');
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { ...actual, useI18n: () => ({ t: en }) };
});

vi.mock('sonner', () => ({ toast: state.toast }));

function sub(overrides: Partial<MailSubscription> = {}): MailSubscription {
  return {
    id: 'msub_1',
    accountId: 'macc_1',
    senderEmail: 'news@shop.example',
    senderName: 'Shop',
    senderDomain: 'shop.example',
    listId: null,
    unsubscribeUrl: 'https://shop.example/u/1',
    unsubscribeMailto: null,
    oneClick: true,
    messageCount: 3,
    lastSubject: 'Deals',
    firstReceivedAt: '2026-11-01T00:00:00.000Z',
    lastReceivedAt: '2026-11-20T00:00:00.000Z',
    status: 'active',
    unsubscribeMethod: null,
    unsubscribedAt: null,
    unsubscribedBy: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  state.mutateAsync.mockReset();
  state.toast.success.mockReset();
  state.toast.info.mockReset();
  state.toast.error.mockReset();
  state.open.mockReset();
  vi.stubGlobal('open', state.open);
});

describe('UnsubscribeSenderButton', () => {
  it('renders nothing for ordinary mail or a sender with no unsubscribe option', () => {
    const { container, rerender } = render(<UnsubscribeSenderButton subscription={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UnsubscribeSenderButton subscription={sub({ unsubscribeUrl: null, oneClick: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows "Unsubscribed" once the sender is unsubscribed', () => {
    render(<UnsubscribeSenderButton subscription={sub({ status: 'unsubscribed' })} />);
    expect(screen.getByText('Unsubscribed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).not.toBeInTheDocument();
  });

  it('confirms, then has WeldMail unsubscribe by one-click', async () => {
    state.mutateAsync.mockResolvedValue({ data: { subscription: sub({ status: 'unsubscribed' }), method: 'one_click', url: null } });
    render(<UnsubscribeSenderButton subscription={sub()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByText('Unsubscribe from Shop?')).toBeInTheDocument();
    expect(screen.getByText('WeldMail will ask Shop to stop sending email to this mailbox.')).toBeInTheDocument();
    expect(state.mutateAsync).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Unsubscribe')!);

    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledWith('msub_1'));
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith('Unsubscribed from Shop'));
    expect(state.open).not.toHaveBeenCalled();
  });

  it('opens the page inside the click for a link-only sender', async () => {
    state.mutateAsync.mockResolvedValue({
      data: { subscription: sub({ status: 'unsubscribed' }), method: 'link', url: 'https://shop.example/u/1' },
    });
    render(<UnsubscribeSenderButton subscription={sub({ oneClick: false })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Unsubscribe')!);

    expect(state.open).toHaveBeenCalledWith('https://shop.example/u/1', '_blank', 'noopener,noreferrer');
    await waitFor(() => expect(state.toast.info).toHaveBeenCalledWith('Finish unsubscribing on the page of Shop'));
  });

  it('reports a failed unsubscribe', async () => {
    state.mutateAsync.mockRejectedValue(new Error('bad gateway'));
    render(<UnsubscribeSenderButton subscription={sub()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Unsubscribe')!);

    await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith('Could not unsubscribe from Shop'));
  });
});
