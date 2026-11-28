import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ThreadMessage } from '@/lib/api/types';
import type { Messenger } from '@/hooks/use-messenger';
import { conversation, fakeMessenger, minutesAgo, SOPHIE, threadMessage, widgetConfig } from '@/__tests__/fixtures';
import { resizeAll } from '@/__tests__/resize-observer';
import { ConversationView } from './conversation-view';

// Article suggestions call the widget API; the thread doesn't need them here.
vi.mock('@/hooks/use-self-service', () => ({ useArticleSuggestions: () => [] }));

const agent = (fields: Partial<ThreadMessage> & { createdAt: string }) =>
  threadMessage({ authorType: 'agent', authorName: SOPHIE.name, ...fields });
const visitor = (fields: Partial<ThreadMessage> & { createdAt: string }) =>
  threadMessage({ authorType: 'visitor', authorName: 'Alex Morgan', ...fields });
const event = (eventType: string, createdAt: string) =>
  threadMessage({ authorType: 'system', kind: 'event', body: null, eventType, createdAt });

function renderThread(thread: ThreadMessage[], overrides: Partial<Messenger> = {}) {
  const messenger = fakeMessenger({
    conversations: [conversation()],
    threads: { conv_test: thread },
    ...overrides,
  });
  const onBack = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ConversationView
      config={widgetConfig()}
      messenger={messenger}
      conversationId="conv_test"
      onCreated={vi.fn()}
      onBack={onBack}
      onClose={onClose}
      isOpen
    />,
  );
  return { ...view, messenger, onBack, onClose };
}

/** The "who · when" lines in the thread: only the newest message has one. */
const sentLines = () => [...document.querySelectorAll('[data-testid="message-list"] time')].map((t) => t.parentElement!);

afterEach(() => {
  vi.useRealTimers();
});

describe('ConversationView: who sent the newest message, and when', () => {
  it('shows the teammate and how long ago under the newest message only', () => {
    const newest = agent({ body: 'Did the email come through?', createdAt: minutesAgo(2) });
    renderThread([
      visitor({ body: 'The export spins forever', createdAt: minutesAgo(50) }),
      agent({ body: 'Which browser?', createdAt: minutesAgo(46) }),
      newest,
    ]);

    const lines = sentLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe('Sophie Bakker · 2m ago');
    expect(lines[0].querySelector('time')?.getAttribute('datetime')).toBe(newest.createdAt);
    expect(lines[0].previousElementSibling?.textContent).toBe('Did the email come through?');
  });

  it('says "You" when the visitor sent the newest message, and skips events after it', () => {
    renderThread([
      agent({ body: 'Sorted it for you', createdAt: minutesAgo(30) }),
      visitor({ body: 'Perfect, thank you!', createdAt: minutesAgo(20) }),
      event('closed', minutesAgo(10)),
    ]);
    const [line] = sentLines();
    expect(line.textContent).toBe('You · 20m ago');
    expect(line.previousElementSibling?.textContent).toBe('Perfect, thank you!');
  });

  it('keeps the time up to date while the conversation is open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T15:00:00Z'));
    renderThread([visitor({ body: 'Hello?', createdAt: new Date().toISOString() })]);
    expect(sentLines()[0].textContent).toBe('You · Just now');

    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(sentLines()[0].textContent).toBe('You · 1m ago');
  });

  it('shows "Sending…" instead while the newest message is on its way', () => {
    renderThread([visitor({ body: 'On its way', createdAt: minutesAgo(0), status: 'sending' })]);
    expect(sentLines()).toHaveLength(0);
    expect(screen.getByText('Sending…')).toBeTruthy();
  });

  it('shows "Sending…" once, under the last of several messages on their way', () => {
    renderThread([
      visitor({ body: 'First', createdAt: minutesAgo(0), status: 'sending' }),
      visitor({ body: 'Second', createdAt: minutesAgo(0), status: 'sending' }),
    ]);
    const sending = screen.getAllByText('Sending…');
    expect(sending).toHaveLength(1);
    expect(sending[0].previousElementSibling?.textContent).toBe('Second');
  });

  it('offers a retry instead when the newest message failed', () => {
    const failed = visitor({ body: 'Lost', createdAt: minutesAgo(0), status: 'failed' });
    const { messenger } = renderThread([failed]);
    expect(sentLines()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Not sent · Tap to retry' }));
    expect(messenger.retry).toHaveBeenCalledWith('conv_test', failed);
  });

  it('shows nothing extra for an empty thread', () => {
    renderThread([]);
    expect(sentLines()).toHaveLength(0);
  });
});

describe('ConversationView: thread layout', () => {
  it('draws events as a divider with a line on each side', () => {
    renderThread([
      visitor({ body: 'Hi', createdAt: minutesAgo(50) }),
      event('assigned', minutesAgo(48)),
      agent({ body: 'Hello!', createdAt: minutesAgo(46) }),
    ]);
    const text = screen.getByText('A teammate joined the conversation');
    const divider = text.parentElement!;
    expect(divider.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(2);
    expect(divider.className).toContain('pt-5');
  });

  it('keeps two events in a row 20px apart, and notes how to reopen a closed conversation', () => {
    renderThread(
      [
        visitor({ body: 'Thanks', createdAt: minutesAgo(40) }),
        event('closed', minutesAgo(30)),
        event('reopened', minutesAgo(20)),
      ],
      { conversations: [conversation({ state: 'closed' })] },
    );
    expect(screen.getByText('Conversation closed').parentElement!.className).toContain('pt-5');
    expect(screen.getByText('Conversation reopened').parentElement!.className).toContain('pt-3');
    expect(screen.getByText('This conversation was closed. Send a message to reopen it.')).toBeTruthy();
  });

  it('joins a message sent right after the one above with a sharp corner', () => {
    renderThread([
      visitor({ body: 'Chrome, about 300 invoices', createdAt: minutesAgo(41) }),
      visitor({ body: "Here's what I see", createdAt: minutesAgo(40) }),
      agent({ body: 'Thanks', createdAt: minutesAgo(38) }),
      agent({ body: 'One more thing', createdAt: minutesAgo(37) }),
    ]);
    const bubble = (text: string) => screen.getByText(text).closest('div[title]')!.className;
    expect(bubble('Chrome, about 300 invoices')).not.toContain('rounded-tr-md');
    expect(bubble("Here's what I see")).toContain('rounded-tr-md');
    expect(bubble('Thanks')).not.toContain('rounded-tl-md');
    expect(bubble('One more thing')).toContain('rounded-tl-md');
  });

  it('keeps who wrote a run of teammate messages for screen readers', () => {
    renderThread([agent({ body: 'Hello', createdAt: minutesAgo(5) })]);
    expect(screen.getByText('Sophie Bakker:').className).toContain('sr-only');
  });
});

describe('ConversationView: header', () => {
  it('is a 56px bar with 34px back and close buttons and an 18px close icon', () => {
    const { onBack, onClose } = renderThread([]);
    const header = document.querySelector('header')!;
    expect(header.className).toContain('h-14');

    const back = screen.getByRole('button', { name: 'Back' });
    const close = screen.getByRole('button', { name: 'Close' });
    expect(back.className).toContain('p-[7px]');
    expect(close.className).toContain('p-2');
    expect(close.querySelector('svg')?.getAttribute('class')).toContain('h-[18px]');

    fireEvent.click(back);
    fireEvent.click(close);
    expect(onBack).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('names the assigned teammate and says how fast the team replies', () => {
    renderThread([]);
    expect(screen.getByText('Sophie Bakker', { selector: 'header p' })).toBeTruthy();
    expect(screen.getByTestId('chat-subtitle').textContent).toBe('Usually replies in a few minutes');
  });
});

describe('ConversationView: the floating reply field', () => {
  it('ends the thread 39px above the bottom and keeps room for the field', () => {
    renderThread([visitor({ body: 'Hi', createdAt: minutesAgo(1) })]);
    const list = screen.getByTestId('message-list');
    expect(list.style.marginBottom).toBe('39px');
    // 62px field + 12px gap - 39px below the thread
    expect(list.style.paddingBottom).toBe('35px');
  });

  it('keeps more room when the field grows', () => {
    renderThread([visitor({ body: 'Hi', createdAt: minutesAgo(1) })]);
    const form = document.querySelector('form')!;
    Object.defineProperty(form, 'offsetHeight', { configurable: true, value: 98 });
    act(() => resizeAll());
    expect(screen.getByTestId('message-list').style.paddingBottom).toBe('71px');
  });

  it('lets clicks through the empty space around the field but not the field itself', () => {
    renderThread([]);
    const form = document.querySelector('form')!;
    expect(form.className).toContain('pointer-events-none');
    expect(form.className).toContain('[&>*]:pointer-events-auto');
    expect(form.className).toContain('px-4');
    expect(form.className).toContain('pb-4');
  });
});
