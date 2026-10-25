import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  installed: true,
  members: [] as Array<{ id: string; userId: string }> | undefined,
  follow: vi.fn(),
  unfollow: vi.fn(),
}));

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_me' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/hooks/use-is-app-installed', () => ({ useIsAppInstalled: () => state.installed }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useChannel: () => ({ data: state.members ? { data: { id: 'ch_1', members: state.members } } : undefined }),
  useFollowRecordChat: () => ({ mutate: state.follow, isPending: false }),
  useUnfollowRecordChat: () => ({ mutate: state.unfollow, isPending: false }),
}));

import { RecordChatPanelBar } from './record-chat-panel-bar';

beforeEach(() => {
  state.installed = true;
  state.members = [];
  state.follow.mockReset();
  state.unfollow.mockReset();
});

describe('RecordChatPanelBar', () => {
  it('links the record\'s chat to its WeldChat page', () => {
    render(<RecordChatPanelBar entityType="company" entityId="cmp_1" channelId="ch_1" />);
    expect(screen.getByTestId('record-chat-open-in-weldchat').getAttribute('href')).toBe('/weldchat/ch_1');
  });

  it('follows a chat the user does not follow yet', () => {
    state.members = [{ id: 'm1', userId: 'user_other' }];
    render(<RecordChatPanelBar entityType="task" entityId="tsk_1" channelId="ch_1" />);
    const button = screen.getByTestId('record-chat-follow');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toContain('sweep.weldchat.recordChats.follow');
    fireEvent.click(button);
    expect(state.follow).toHaveBeenCalledWith(
      { entityType: 'task', entityId: 'tsk_1', channelId: 'ch_1' },
      expect.anything(),
    );
  });

  it('unfollows a chat the user follows', () => {
    state.members = [{ id: 'm1', userId: 'user_me' }];
    render(<RecordChatPanelBar entityType="person" entityId="per_1" channelId="ch_1" />);
    const button = screen.getByTestId('record-chat-follow');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(state.unfollow).toHaveBeenCalledWith(
      { entityType: 'person', entityId: 'per_1', channelId: 'ch_1' },
      expect.anything(),
    );
    expect(state.follow).not.toHaveBeenCalled();
  });

  it('shows nothing before the chat exists', () => {
    const { container } = render(<RecordChatPanelBar entityType="company" entityId="cmp_1" channelId={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows nothing for a type WeldChat does not list', () => {
    const { container } = render(<RecordChatPanelBar entityType="contact" entityId="per_1" channelId="ch_1" />);
    expect(container.innerHTML).toBe('');
  });

  it('shows nothing in a workspace without WeldChat', () => {
    state.installed = false;
    const { container } = render(<RecordChatPanelBar entityType="company" entityId="cmp_1" channelId="ch_1" />);
    expect(container.innerHTML).toBe('');
  });
});
