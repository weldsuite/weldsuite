import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

interface ChannelFixture {
  id: string;
  type: string;
  name: string | null;
  isPrivate?: boolean;
  entityType?: string | null;
}

const mocks = vi.hoisted(() => ({
  channel: undefined as ChannelFixture | undefined,
  dms: [] as Array<{ id: string; name: string | null; otherMembers?: Array<{ name: string | null }> }>,
  useDmChannels: vi.fn(),
  closeThread: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en }) }));
vi.mock('./chat-context', () => ({ useChatContext: () => ({ closeThread: mocks.closeThread }) }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useChannel: () => ({ data: mocks.channel ? { data: mocks.channel } : undefined }),
  useDmChannels: (enabled: boolean) => {
    mocks.useDmChannels(enabled);
    return { data: enabled ? { data: mocks.dms } : undefined };
  },
}));
// The conversation itself has tests of its own.
vi.mock('./message-list', () => ({ MessageList: () => <div data-testid="messages" /> }));
vi.mock('./message-input', () => ({ MessageInput: () => <div data-testid="composer" /> }));
vi.mock('./chat-drop-zone', () => ({
  ChatDropZone: ({ targetName, children }: { targetName: string; children: ReactNode }) => (
    <div data-testid="drop-zone" data-target={targetName}>
      {children}
    </div>
  ),
}));

import { ThreadPanel } from './thread-panel';

const tp = en.weldchat.threadPanel;

function renderPanel() {
  return render(<ThreadPanel channelId="ch_1" messageId="msg_1" />);
}

/** The heading's conversation part: the icon (if any) and the name. */
const conversation = (name: string) => screen.getByText(name).parentElement as HTMLElement;

beforeEach(() => {
  mocks.channel = undefined;
  mocks.dms = [];
  mocks.useDmChannels.mockReset();
  localStorage.clear();
});

afterEach(cleanup);

describe('ThreadPanel heading', () => {
  it('names a channel with its privacy icon, without loading the DM list', () => {
    mocks.channel = { id: 'ch_1', type: 'public', name: 'general' };
    renderPanel();

    expect(conversation('general').querySelector('svg')).not.toBeNull();
    expect(mocks.useDmChannels).toHaveBeenCalledWith(false);
  });

  it('names a DM after who it is with, without a privacy icon', () => {
    mocks.channel = { id: 'ch_1', type: 'dm', name: 'dm-ann-bob' };
    mocks.dms = [
      { id: 'ch_other', name: 'x', otherMembers: [{ name: 'Someone else' }] },
      { id: 'ch_1', name: 'dm-ann-bob', otherMembers: [{ name: 'Ann Archer' }, { name: null }, { name: 'Bob Baker' }] },
    ];
    renderPanel();

    expect(conversation('Ann Archer, Bob Baker').querySelector('svg')).toBeNull();
    expect(screen.queryByText('dm-ann-bob')).toBeNull();
    expect(mocks.useDmChannels).toHaveBeenCalledWith(true);
  });

  it("keeps a group's own name until the DM list knows who it is with", () => {
    mocks.channel = { id: 'ch_1', type: 'group', name: 'Launch crew' };
    renderPanel();

    expect(conversation('Launch crew').querySelector('svg')).toBeNull();
  });

  it("shows a record chat's app logo", () => {
    mocks.channel = { id: 'ch_1', type: 'private', name: 'Acme BV', isPrivate: true, entityType: 'company' };
    renderPanel();

    expect(conversation('Acme BV').querySelector('img')?.dataset.appLogo).toBe('weldcrm');
    expect(conversation('Acme BV').querySelector('svg')).toBeNull();
  });

  it('leaves the conversation out while the channel loads', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: tp.defaultName })).toBeTruthy();
    expect(screen.getByRole('button', { name: tp.defaultName }).parentElement?.children).toHaveLength(2);
  });

  it('drops files into the thread, and closes', () => {
    mocks.channel = { id: 'ch_1', type: 'public', name: 'general' };
    renderPanel();

    expect(screen.getByTestId('drop-zone').dataset.target).toBe(en.weldchat.dropZone.thread);
    fireEvent.click(screen.getByRole('button', { name: tp.close }));
    expect(mocks.closeThread).toHaveBeenCalledTimes(1);
  });
});
