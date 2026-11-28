import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Messenger } from '@/hooks/use-messenger';
import { conversation, fakeMessenger, widgetConfig } from '@/__tests__/fixtures';
import { HomeView } from './home-view';

// Announcements are fetched from the widget API; Home doesn't need any here.
vi.mock('@/hooks/use-self-service', () => ({ useAnnouncements: () => [] }));

function renderHome(overrides: Partial<Messenger> = {}, withClose = true) {
  const handlers = { onNewConversation: vi.fn(), onOpenConversation: vi.fn(), onClose: vi.fn() };
  render(
    <HomeView
      config={widgetConfig()}
      messenger={fakeMessenger(overrides)}
      onNewConversation={handlers.onNewConversation}
      onOpenConversation={handlers.onOpenConversation}
      onClose={withClose ? handlers.onClose : undefined}
    />,
  );
  return handlers;
}

describe('HomeView', () => {
  it('greets the visitor by first name over the dark backdrop', () => {
    renderHome();
    const hi = screen.getByRole('heading', { level: 1 });
    expect(hi.textContent).toBe('Hi Alex 👋');
    expect(hi.className).toContain('text-white/65');
    expect(screen.getByText('How can we help?').className).toContain('text-[28px]');
  });

  it('says "Hi there" when it does not know the name', () => {
    renderHome({ profile: { name: '', email: '' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Hi there 👋');
  });

  // jsdom can't parse the backdrop's layered gradients, so only the layers are checked here.
  it('lays the haze and the fade over the backdrop, hidden from screen readers and clicks', () => {
    renderHome();
    const header = screen.getByRole('heading', { level: 1 }).closest('div.relative.pl-10') as HTMLElement;
    const layers = header.querySelectorAll(':scope > div[aria-hidden="true"]');
    expect(layers).toHaveLength(2);
    for (const layer of layers) expect(layer.className).toContain('pointer-events-none');
  });

  it('shows the team as 40px faces that barely overlap', () => {
    renderHome();
    const daan = screen.getByLabelText('Daan de Vries');
    expect(daan.style.width).toBe('40px');
    expect(daan.style.marginLeft).toBe('-2px');
  });

  it('closes from a 34px button with an 18px icon', () => {
    const { onClose } = renderHome();
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toContain('p-2');
    expect(close.querySelector('svg')?.getAttribute('class')).toContain('h-[18px]');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('has no close button when the page can not close it', () => {
    renderHome({}, false);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('opens the recent conversation and starts a new one', () => {
    const { onOpenConversation, onNewConversation } = renderHome({ conversations: [conversation()] });
    fireEvent.click(screen.getByText('Recent message'));
    expect(onOpenConversation).toHaveBeenCalledWith('conv_test');
    fireEvent.click(screen.getByTestId('new-conversation'));
    expect(onNewConversation).toHaveBeenCalledOnce();
  });
});
