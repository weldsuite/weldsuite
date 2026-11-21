import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({ typing: [] as Array<{ userId: string; userName?: string }> }));

vi.mock('@/hooks/weldchat/use-weldchat-typing', () => ({ useTypingSubscriber: () => state.typing }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useWorkspaceMembers: () => ({
    data: { data: [{ id: 'mbr_gert', userId: 'user_gert', name: 'Gert' }, { id: 'mbr_ann', userId: 'user_ann', name: 'Ann' }] },
  }),
}));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        typingIndicator: {
          someone: 'Someone',
          isTyping: '{name} is typing',
          twoTyping: '{name1} and {name2} are typing',
          multipleTyping: '{names} and {last} are typing',
          manyTyping: 'Multiple people are typing',
          agentWorking: '{name} is working',
          agentsWorking: '{names} are working',
        },
      },
    },
  }),
}));

import { TypingIndicator } from './typing-indicator';

beforeEach(() => {
  state.typing = [];
});

describe('TypingIndicator', () => {
  it('shows nothing while nobody types', () => {
    const { container } = render(<TypingIndicator channelId="ch_1" />);
    expect(container.textContent).toBe('');
  });

  it('names who is typing, the name a shade darker than the rest', () => {
    state.typing = [{ userId: 'user_gert' }];
    render(<TypingIndicator channelId="ch_1" />);
    const name = screen.getByText('Gert');
    expect(name.className).toContain('font-medium');
    expect(name.parentElement?.textContent).toBe('Gert is typing');
  });

  it('names two people, and an agent working beside them', () => {
    state.typing = [{ userId: 'user_gert' }, { userId: 'user_ann' }, { userId: 'agt_1', userName: 'Scout' }];
    render(<TypingIndicator channelId="ch_1" />);
    expect(screen.getByText('Gert').parentElement?.textContent).toBe('Gert and Ann are typing · Scout is working');
  });
});
