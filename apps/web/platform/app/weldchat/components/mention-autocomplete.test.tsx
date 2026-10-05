import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useWorkspaceMembers: () => ({
    data: { data: [{ userId: 'user_1', name: 'Gert', email: 'g@example.com' }, { userId: 'user_2', name: 'Gerda' }] },
  }),
  useChannelMembers: () => ({ data: { data: [] } }),
  useChannel: () => ({ data: { data: { type: 'public' } } }),
}));
vi.mock('@/hooks/queries/use-global-search-queries', () => ({
  useGlobalSearch: () => ({ data: { data: [] }, isFetching: false }),
}));
vi.mock('@/lib/search/result-types', () => ({ RESULT_TYPE_ICON: {}, RESULT_TYPE_LABEL: {} }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: { weldchat: { mentionAutocomplete: { agent: 'Agent' } } } }),
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
