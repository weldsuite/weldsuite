import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

const agents = vi.hoisted(() => ({
  canUse: false,
  inChannel: [] as Array<{ userId: string; name: string; memberType: string; agentIcon: string | null }>,
  workspace: [] as Array<{ id: string; name: string; icon: string | null }>,
  invite: vi.fn(async () => ['agt_new']),
}));

vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useWorkspaceMembers: () => ({
    data: { data: [{ userId: 'user_1', name: 'Gert', email: 'g@example.com' }, { userId: 'user_2', name: 'Gerda' }] },
  }),
  useChannelMembers: () => ({ data: { data: agents.inChannel } }),
  useChannel: () => ({ data: { data: { type: 'public' } } }),
  useInviteChannelAgents: () => ({ mutateAsync: agents.invite }),
}));
vi.mock('@/hooks/queries/use-agent-queries', () => ({
  useAgents: () => ({ data: agents.workspace }),
}));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => agents.canUse }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-global-search-queries', () => ({
  useGlobalSearch: () => ({ data: { data: [] }, isFetching: false }),
}));
vi.mock('@/lib/search/result-types', () => ({ RESULT_TYPE_ICON: {}, RESULT_TYPE_LABEL: {} }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        mentionAutocomplete: { agent: 'Agent', addToChat: 'Add to chat' },
        memberList: { agentAdded: '{name} joined', addAgentFailed: 'Could not add {name}' },
      },
    },
  }),
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));

import { MentionAutocomplete } from './mention-autocomplete';

/** The popup next to a contentEditable, inside a composer root like message-input's. */
function setup(query = 'Ger') {
  const onSelect = vi.fn();
  const onDismiss = vi.fn();
  const editorKeyDown = vi.fn();
  const ui = render(
    <div data-chat-composer-root="">
      <MentionAutocomplete query={query} channelId="ch_1" onSelect={onSelect} onDismiss={onDismiss} />
      <div data-testid="editor" contentEditable suppressContentEditableWarning onKeyDown={(e) => editorKeyDown(e.key)} />
    </div>,
  );
  return { ...ui, onSelect, onDismiss, editorKeyDown };
}

describe('MentionAutocomplete keyboard', () => {
  it('Enter selects the highlighted item and never reaches the composer (so nothing is sent)', () => {
    const { getByTestId, onSelect, editorKeyDown } = setup();
    fireEvent.keyDown(getByTestId('editor'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ kind: 'user' });
    expect(editorKeyDown).not.toHaveBeenCalled();
  });

  it('arrow keys move the highlight, Enter then selects that item', () => {
    const { getByTestId, onSelect, editorKeyDown } = setup();
    const editor = getByTestId('editor');
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith({ kind: 'user', userId: 'user_2', name: 'Gerda' });
    expect(editorKeyDown).not.toHaveBeenCalled();
  });

  it('Tab selects too', () => {
    const { getByTestId, onSelect } = setup();
    fireEvent.keyDown(getByTestId('editor'), { key: 'Tab' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the popup and is consumed, so it cannot also cancel a reply/edit', () => {
    const { getByTestId, onDismiss, editorKeyDown } = setup();
    fireEvent.keyDown(getByTestId('editor'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
    expect(editorKeyDown).not.toHaveBeenCalled();
  });

  it('Escape reaches the composer when no popup is showing', () => {
    const { getByTestId, editorKeyDown } = setup('zzzz');
    fireEvent.keyDown(getByTestId('editor'), { key: 'Escape' });
    expect(editorKeyDown).toHaveBeenCalledWith('Escape');
  });

  it('with no matching people Enter goes to the composer instead of being swallowed', () => {
    const { getByTestId, onSelect, editorKeyDown } = setup('zzzz');
    fireEvent.keyDown(getByTestId('editor'), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(editorKeyDown).toHaveBeenCalledWith('Enter');
  });

  it('ignores keys typed in another composer', () => {
    const { onSelect } = setup();
    const other = document.createElement('div');
    document.body.appendChild(other);
    fireEvent.keyDown(other, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    other.remove();
  });
});

describe('MentionAutocomplete pointer', () => {
  it('ignores a click on a row that just appeared or moved, then accepts one once the list settles', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const { getByText, onSelect } = setup();

    // Same instant the list (re)rendered: the row may have slid under the pointer.
    fireEvent.mouseDown(getByText('Gerda'));
    expect(onSelect).not.toHaveBeenCalled();

    now.mockReturnValue(1_500);
    fireEvent.mouseDown(getByText('Gerda'));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'user', userId: 'user_2', name: 'Gerda' });
    now.mockRestore();
  });
});

describe('MentionAutocomplete agents', () => {
  beforeEach(() => {
    agents.canUse = true;
    agents.inChannel = [{ userId: 'agt_in', name: 'Gerty Bot', memberType: 'agent', agentIcon: null }];
    agents.workspace = [
      { id: 'agt_in', name: 'Gerty Bot', icon: null },
      { id: 'agt_new', name: 'Germaine Researcher', icon: '🔎' },
    ];
    agents.invite.mockClear();
  });

  it('lists agents in the channel first and offers the others to add', () => {
    const { getAllByRole, getByText } = setup();
    const rows = getAllByRole('button').map((b) => b.textContent);
    expect(rows[0]).toContain('Gerty Bot');
    expect(rows[1]).toContain('Germaine Researcher');
    expect(getByText('Add to chat')).toBeTruthy();
  });

  it('picking an agent from outside the channel adds it, then inserts the mention', async () => {
    const { getByTestId, onSelect } = setup('Germaine');
    fireEvent.keyDown(getByTestId('editor'), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith({ kind: 'user', userId: 'agt_new', name: 'Germaine Researcher' }),
    );
    expect(agents.invite).toHaveBeenCalledWith({ channelId: 'ch_1', agentIds: ['agt_new'] });
  });

  it('does not insert the mention when the agent could not be added', async () => {
    agents.invite.mockRejectedValueOnce(new Error('nope'));
    const { getByTestId, onSelect } = setup('Germaine');
    fireEvent.keyDown(getByTestId('editor'), { key: 'Enter' });
    await waitFor(() => expect(agents.invite).toHaveBeenCalled());
    await Promise.resolve();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('offers no outside agents without weldagent:use', () => {
    agents.canUse = false;
    const { queryByText } = setup('Germaine');
    expect(queryByText('Germaine Researcher')).toBeNull();
  });
});
