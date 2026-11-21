import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns], getLocale: () => 'en' };
});

import { MessageVisuals } from './message-visuals';
import { COMPOSE_INPUT_EVENT, type ComposeInputDetail } from './chat-context';

const stats = {
  type: 'stats',
  title: 'This week',
  items: [{ label: 'New leads', value: 14 }],
};

afterEach(() => vi.restoreAllMocks());

describe('MessageVisuals', () => {
  it('draws the visuals an agent showed', async () => {
    render(<MessageVisuals message={{ authorType: 'agent', authorId: 'agt_1', metadata: { visuals: [stats] } }} />);
    expect(await screen.findByText('New leads', {}, { timeout: 15_000 })).toBeTruthy();
  }, 20_000);

  it('draws nothing for a person, or for a spec that does not parse', () => {
    const { container } = render(
      <>
        <MessageVisuals message={{ authorType: 'user', authorId: 'user_1', metadata: { visuals: [stats] } }} />
        <MessageVisuals message={{ authorType: 'agent', authorId: 'agt_1', metadata: { visuals: [{ type: 'nope' }] } }} />
      </>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('asks the agent about a tile in the composer of its thread', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const seen: ComposeInputDetail[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent<ComposeInputDetail>).detail);
    window.addEventListener(COMPOSE_INPUT_EVENT, listener);

    render(
      <MessageVisuals
        message={{ authorType: 'agent', authorId: 'agt_1', parentId: 'msg_root', metadata: { visuals: [stats] } }}
      />,
    );
    fireEvent.click(await screen.findByText('New leads', {}, { timeout: 15_000 }));

    window.removeEventListener(COMPOSE_INPUT_EVENT, listener);
    expect(seen).toEqual([
      { parentId: 'msg_root', content: '<@agt_1> Tell me more about “New leads” (14) in “This week”.' },
    ]);
  }, 20_000);
});
