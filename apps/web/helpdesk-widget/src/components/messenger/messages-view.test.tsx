import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { conversation, fakeMessenger, widgetConfig } from '@/__tests__/fixtures';
import { MessagesView } from './messages-view';

function renderMessages() {
  const handlers = { onNewConversation: vi.fn(), onOpenConversation: vi.fn(), onClose: vi.fn() };
  render(
    <MessagesView
      config={widgetConfig()}
      messenger={fakeMessenger({ conversations: [conversation({ lastMessageAt: new Date().toISOString() })] })}
      {...handlers}
    />,
  );
  return handlers;
}

describe('MessagesView', () => {
  it('has a 56px header whose 34px close button sits 8px from the edge', () => {
    const { onClose } = renderMessages();
    expect(document.querySelector('header')?.className).toContain('h-14');
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toContain('right-2');
    expect(close.className).toContain('p-2');
    expect(close.querySelector('svg')?.getAttribute('class')).toContain('h-[18px]');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lists conversations with 36px avatars and a 14px sender line', () => {
    const { onOpenConversation } = renderMessages();
    expect(screen.getByLabelText('Sophie Bakker').style.width).toBe('36px');
    const meta = screen.getByText(/Sophie Bakker · now/);
    expect(meta.className).toContain('text-sm');
    fireEvent.click(screen.getByText('Did the email come through?'));
    expect(onOpenConversation).toHaveBeenCalledWith('conv_test');
  });

  it('starts a new conversation from the send button', () => {
    const { onNewConversation } = renderMessages();
    fireEvent.click(screen.getByRole('button', { name: /Send us a message/ }));
    expect(onNewConversation).toHaveBeenCalledOnce();
  });
});
