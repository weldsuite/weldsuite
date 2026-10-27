import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  edit: vi.fn(),
  setReplyTo: vi.fn(),
  setEditingMessage: vi.fn(),
  deleteDraft: vi.fn(),
  getClient: vi.fn(),
  upload: vi.fn(),
  ctx: {
    replyTo: null as null | { messageId: string; authorName: string; content: string; parentId?: string | null },
    editingMessage: null as null | {
      messageId: string;
      content: string;
      parentId?: string | null;
      attachments?: Array<{ id: string; url?: string; fileName?: string }>;
    },
  },
  channel: { type: 'public' } as Record<string, unknown>,
  restore: null as null | ((content: string, attachments: unknown[]) => void),
}));

vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useSendMessage: () => ({ mutate: mocks.send, isPending: false }),
  useEditMessage: () => ({ mutate: mocks.edit, isPending: false }),
  useWorkspaceMembers: () => ({
    data: { data: [{ userId: 'user_1', name: 'Gert' }, { userId: 'user_2', name: 'Zed' }] },
  }),
  useChannel: () => ({ data: { data: mocks.channel } }),
  useChannelMembers: () => ({ data: { data: [] } }),
  useInviteChannelAgents: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-agent-queries', () => ({ useAgents: () => ({ data: [] }) }));
vi.mock('@/hooks/queries/use-global-search-queries', () => ({
  useGlobalSearch: () => ({ data: { data: [] }, isFetching: false }),
}));
vi.mock('@/hooks/queries/use-task-queries', () => ({ useCreateTask: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('@/hooks/weldchat/use-weldchat-typing', () => ({
  useTypingPublisher: () => ({ onKeystroke: vi.fn(), onSend: vi.fn() }),
}));
vi.mock('@/hooks/weldchat/use-clip-recorder', () => ({
  useClipRecorder: () => ({
    state: 'idle',
    stream: null,
    blob: null,
    duration: 0,
    audioLevel: 0,
    setMode: vi.fn(),
    startPreview: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock('@/hooks/weldchat/use-draft-autosave', () => ({
  useDraftAutosave: (opts: { onRestore?: (content: string, attachments: unknown[]) => void }) => {
    mocks.restore = opts.onRestore ?? null;
    return { draftId: null, deleteDraft: mocks.deleteDraft };
  },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: mocks.getClient }) }));
vi.mock('../lib/chat-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/chat-upload')>()),
  uploadChatFile: mocks.upload,
}));
vi.mock('./chat-context', () => ({
  useChatContext: () => ({
    replyTo: mocks.ctx.replyTo,
    setReplyTo: mocks.setReplyTo,
    editingMessage: mocks.ctx.editingMessage,
    setEditingMessage: mocks.setEditingMessage,
    openThread: vi.fn(),
  }),
}));
vi.mock('./clip-recorder', () => ({ ClipRecorder: () => null }));
vi.mock('./typing-indicator', () => ({ TypingIndicator: () => null }));
vi.mock('./emoji-picker', () => ({ EmojiPicker: () => null }));
vi.mock('@/lib/search/result-types', () => ({ RESULT_TYPE_ICON: {}, RESULT_TYPE_LABEL: {} }));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        messageInput: {
          placeholder: 'Message',
          addAttachment: 'Add attachment',
          emoji: 'Emoji',
          mentionSomeone: 'Mention someone',
          formatting: 'Formatting',
          recordClip: 'Record a clip',
          recordVoiceClip: 'Record voice clip',
          sendMessage: 'Send message',
          uploading: 'Uploading',
          uploadFailed: 'Upload failed',
          cancel: 'Cancel',
          stopRecording: 'Stop',
          sendVoiceClip: 'Send voice clip',
          threadSuggestion: 'Thread?',
          createThread: 'Create thread',
          dismissThreadSuggestion: 'Dismiss',
        },
        messageContextMenu: {
          editMessage: 'Edit message',
          messageEdited: 'Edited',
          messageEditFailed: 'Edit failed',
        },
        slashCommandPalette: {
          commands: { createtask: 'Create a task' },
          taskCreated: 'Task created',
          viewTask: 'View',
          taskCreateFailed: 'Failed',
        },
        mentionAutocomplete: { agent: 'Agent' },
      },
    },
  }),
}));

import { MessageInput } from './message-input';

const CHIP =
  '<span class="mention-badge" contenteditable="false" data-userid="user_2">@Zed</span>';

function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="chat-composer"]') as HTMLElement;
}

/** Type `text` at the end of the editor the way the browser would: edit the DOM, move the caret, fire `input`. */
function type(editor: HTMLElement, text: string) {
  let node = editor.lastChild;
  if (!node || node.nodeType !== 3) {
    node = document.createTextNode('');
    editor.appendChild(node);
  }
  (node as Text).data += text;
  const range = document.createRange();
  range.setStart(node, (node as Text).length);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  fireEvent.input(editor);
}

beforeAll(() => {
  // jsdom has no layout, hence no innerText.
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent;
    },
    set(value: string) {
      this.textContent = value;
    },
  });
  if (!('randomUUID' in crypto)) {
    Object.defineProperty(crypto, 'randomUUID', { value: () => '00000000-0000-4000-8000-000000000000' });
  }
  // jsdom has no object URLs.
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:local-preview' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
});

beforeEach(() => {
  mocks.getClient.mockReset();
  mocks.getClient.mockResolvedValue({});
  mocks.upload.mockReset();
  mocks.send.mockReset();
  mocks.edit.mockReset();
  mocks.setReplyTo.mockReset();
  mocks.setEditingMessage.mockReset();
  mocks.deleteDraft.mockReset();
  mocks.ctx.replyTo = null;
  mocks.ctx.editingMessage = null;
  mocks.channel = { type: 'public' };
  mocks.restore = null;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MessageInput: mention popup and Enter', () => {
  it('Enter with the mention popup open picks the mention and does not send', () => {
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, 'hi @Ger');
    expect(screen.getByText('Gert')).toBeTruthy();

    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(mocks.send).not.toHaveBeenCalled();
    expect(editor.querySelectorAll('.mention-badge')).toHaveLength(1);
    expect(editor.querySelector('.mention-badge')?.getAttribute('data-userid')).toBe('user_1');
    expect(editor.textContent).toBe('hi @Gert ');
  });

  it('a second Enter then sends the message with the mention', () => {
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, 'hi @Ger');
    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      channelId: 'ch_1',
      content: 'hi <@user_1>',
      mentions: ['user_1'],
    });
  });

  it('Enter without a popup sends as before', () => {
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, 'hello');
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ content: 'hello' });
  });

  it('Enter on a bare "/" completes the command instead of posting "/"', () => {
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, '/');
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('/createtask ');
  });

  it('selecting a mention keeps earlier chips and formatting and never turns typed text into markup', () => {
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    editor.innerHTML = `<b>bold</b> ${CHIP} `;
    type(editor, '<img src=x onerror=window.__xss=1> @Ger');

    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(editor.querySelector('img')).toBeNull();
    expect(editor.querySelector('b')?.textContent).toBe('bold');
    expect(editor.querySelectorAll('.mention-badge')).toHaveLength(2);
    expect(editor.textContent).toContain('<img src=x onerror=window.__xss=1> ');

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      content: '**bold** <@user_2> <img src=x onerror=window.__xss=1> <@user_1>',
      mentions: ['user_2', 'user_1'],
    });
  });

  it('puts the caret after the inserted chip so typing continues there', () => {
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, '@Ger');
    fireEvent.keyDown(editor, { key: 'Enter' });
    const range = window.getSelection()?.getRangeAt(0);
    expect(range?.startContainer.previousSibling).toBe(editor.querySelector('.mention-badge'));
  });
});

describe('MessageInput: edit and reply cancel', () => {
  it('loads an edited message with its mentions as chips, not raw tokens', () => {
    mocks.ctx.editingMessage = { messageId: 'msg_1', content: 'hi <@user_1> and <@customer:cus_1|Acme>' };
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    expect(editor.querySelectorAll('.mention-badge')).toHaveLength(1);
    expect(editor.querySelectorAll('.entity-mention-badge')).toHaveLength(1);
    expect(editor.textContent).not.toContain('<@');
  });

  it('Esc while editing clears the composer and ends the edit', () => {
    mocks.ctx.editingMessage = { messageId: 'msg_1', content: 'old text <@user_1>' };
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    expect(editor.textContent).toContain('old text');

    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(mocks.setEditingMessage).toHaveBeenCalledWith(null);
    expect(editor.textContent).toBe('');
  });

  it('Esc with the mention popup open only closes it; a second Esc cancels the edit', () => {
    mocks.ctx.editingMessage = { messageId: 'msg_1', content: 'old text ' };
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, '@Ger');
    expect(screen.getByText('Gert')).toBeTruthy();

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(mocks.setEditingMessage).not.toHaveBeenCalled();
    expect(editor.textContent).toContain('old text');
    expect(screen.queryByText('Gert')).toBeNull();

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(mocks.setEditingMessage).toHaveBeenCalledWith(null);
    expect(editor.textContent).toBe('');
  });

  it('Esc with the slash palette open only closes it; a second Esc cancels the reply', () => {
    mocks.ctx.replyTo = { messageId: 'msg_9', authorName: 'Zed', content: 'quoted' };
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, '/');
    expect(screen.getByText('/createtask')).toBeTruthy();

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(mocks.setReplyTo).not.toHaveBeenCalled();
    expect(screen.queryByText('/createtask')).toBeNull();

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(mocks.setReplyTo).toHaveBeenCalledWith(null);
  });

  it('the banner X while editing clears the composer too', () => {
    mocks.ctx.editingMessage = { messageId: 'msg_1', content: 'old text' };
    const { container } = render(<MessageInput channelId="ch_1" />);
    const banner = screen.getByText('Edit message').closest('div') as HTMLElement;
    fireEvent.click(banner.parentElement?.querySelector('button') as HTMLElement);
    expect(mocks.setEditingMessage).toHaveBeenCalledWith(null);
    expect(editorOf(container).textContent).toBe('');
  });

  it('Esc while replying keeps what was typed', () => {
    mocks.ctx.replyTo = { messageId: 'msg_9', authorName: 'Zed', content: 'quoted' };
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, 'my answer');

    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(mocks.setReplyTo).toHaveBeenCalledWith(null);
    expect(mocks.setEditingMessage).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('my answer');
  });
});

describe('MessageInput: draft restore', () => {
  it('renders a restored draft with chips instead of raw tokens', () => {
    const { container } = render(<MessageInput channelId="ch_1" />);
    act(() => {
      mocks.restore?.('draft for <@user_2>', []);
    });
    const editor = editorOf(container);
    expect(editor.querySelector('.mention-badge')?.getAttribute('data-userid')).toBe('user_2');
    expect(editor.textContent).toBe('draft for @Zed');
  });
});

describe('MessageInput: channel attachment lock', () => {
  it('shows the attachment, clip and voice buttons by default', () => {
    render(<MessageInput channelId="ch_1" />);
    expect(screen.getByTitle('Add attachment')).toBeTruthy();
    expect(screen.getByTitle('Record a clip')).toBeTruthy();
    expect(screen.getByTitle('Record voice clip')).toBeTruthy();
  });

  it('hides them when the channel has attachments off', () => {
    mocks.channel = { type: 'public', attachmentsEnabled: false };
    render(<MessageInput channelId="ch_1" />);
    expect(screen.queryByTitle('Add attachment')).toBeNull();
    expect(screen.queryByTitle('Record a clip')).toBeNull();
    expect(screen.queryByTitle('Record voice clip')).toBeNull();
    // Text composing is untouched.
    expect(screen.getByTitle('Mention someone')).toBeTruthy();
  });

  it('ignores a pasted file when attachments are off, without inlining it', () => {
    mocks.channel = { type: 'public', attachmentsEnabled: false };
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(editor, {
      clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] },
    });
    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(editor.querySelector('img')).toBeNull();
  });

  it('ignores files dropped on the chat surface when attachments are off', () => {
    mocks.channel = { type: 'public', attachmentsEnabled: false };
    render(<MessageInput channelId="ch_1" />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent('weldchat:dropped-files', {
          detail: { channelId: 'ch_1', parentId: null, files: [new File(['x'], 'a.pdf')] },
        }),
      );
    });
    expect(mocks.getClient).not.toHaveBeenCalled();
  });
});

describe('MessageInput: images pasted into the text', () => {
  const uploaded = (id: string) => ({ id, url: `https://files.test/${id}.png`, mimeType: 'image/png' });

  /** Put the caret `offset` characters into the editor's first text node. */
  function caretAt(editor: HTMLElement, offset: number) {
    const range = document.createRange();
    range.setStart(editor.firstChild as Text, offset);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  function pasteImage(editor: HTMLElement, name = 'image.png') {
    const file = new File(['x'], name, { type: 'image/png' });
    fireEvent.paste(editor, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] } });
  }

  it('places the image at the caret and sends it there', async () => {
    mocks.upload.mockResolvedValue(uploaded('att_1'));
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, 'before after');
    caretAt(editor, 'before '.length);

    pasteImage(editor);
    // The placeholder is in the text straight away, before the upload lands.
    const node = editor.querySelector('.inline-image') as HTMLElement;
    expect(node.hasAttribute('data-pending')).toBe(true);
    expect(node.previousSibling?.textContent).toBe('before ');
    expect(screen.queryByText('Uploading')).toBeNull();

    await act(async () => {});
    expect(node.dataset.fileId).toBe('att_1');

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const sent = mocks.send.mock.calls[0][0];
    expect(sent.content).toBe('before <@file:att_1>after');
    expect(sent.mentions).toBeUndefined();
    expect(sent.attachments).toEqual([
      expect.objectContaining({ id: 'att_1', url: 'https://files.test/att_1.png', mimeType: 'image/png' }),
    ]);
  });

  it('blocks sending while the pasted image uploads', () => {
    mocks.upload.mockReturnValue(new Promise(() => {}));
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, 'look');
    pasteImage(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('takes the image out of the text when its upload fails', async () => {
    mocks.upload.mockRejectedValue(new Error('nope'));
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, 'look');
    pasteImage(editor);
    await act(async () => {});
    expect(editor.querySelector('.inline-image')).toBeNull();
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ content: 'look', attachments: undefined });
  });

  it('an image deleted from the text is not sent', async () => {
    mocks.upload.mockResolvedValue(uploaded('att_1'));
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    type(editor, 'look');
    pasteImage(editor);
    await act(async () => {});

    editor.querySelector('.inline-image')?.remove();
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ content: 'look', attachments: undefined });
  });

  it('a message of only an image keeps the editor content (no placeholder wipe)', async () => {
    mocks.upload.mockResolvedValue(uploaded('att_1'));
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    editor.focus();
    pasteImage(editor);
    await act(async () => {});
    fireEvent.input(editor);
    expect(editor.querySelector('.inline-image')).not.toBeNull();

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ content: '<@file:att_1>' });
  });

  it('drops file tokens it did not upload (e.g. pasted markup)', () => {
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    editor.innerHTML = 'hi <span class="inline-image" contenteditable="false" data-file-id="att_other"></span>';
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ content: 'hi', attachments: undefined });
  });

  it('restores a draft with its placed image in the text and the rest in the strip', () => {
    const { container } = render(<MessageInput channelId="ch_1" />);
    const placed = { id: 'att_1', fileName: 'shot.png', fileSize: 1, mimeType: 'image/png', url: 'https://files.test/att_1.png' };
    const loose = { id: 'att_2', fileName: 'doc.pdf', fileSize: 1, mimeType: 'application/pdf', url: 'https://files.test/att_2.pdf' };
    act(() => {
      mocks.restore?.('see <@file:att_1> here', [placed, loose]);
    });
    const editor = editorOf(container);
    expect(editor.querySelector('.inline-image img')?.getAttribute('src')).toBe(placed.url);
    expect(screen.getByText('doc.pdf')).toBeTruthy();
    expect(screen.queryByAltText('shot.png')?.closest('.inline-image')).toBeTruthy();

    fireEvent.keyDown(editor, { key: 'Enter' });
    const sent = mocks.send.mock.calls[0][0];
    expect(sent.content).toBe('see <@file:att_1> here');
    expect(sent.attachments.map((a: { id: string }) => a.id)).toEqual(['att_2', 'att_1']);
  });

  it('shows the placed image while editing and keeps its token', () => {
    mocks.ctx.editingMessage = {
      messageId: 'msg_1',
      content: 'old <@file:att_1> text',
      attachments: [{ id: 'att_1', url: 'https://files.test/att_1.png', fileName: 'shot.png' }],
    };
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    expect(editor.querySelector('.inline-image img')?.getAttribute('src')).toBe('https://files.test/att_1.png');

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(mocks.edit.mock.calls[0][0]).toMatchObject({ content: 'old <@file:att_1> text' });
  });

  it('a pasted non-image file still goes to the strip', async () => {
    mocks.upload.mockResolvedValue({ id: 'att_9', url: 'https://files.test/a.pdf', mimeType: 'application/pdf' });
    const { container } = render(<MessageInput channelId="ch_1" />);
    const editor = editorOf(container);
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    fireEvent.paste(editor, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] } });
    await act(async () => {});
    expect(editor.querySelector('.inline-image')).toBeNull();
    expect(screen.getByText('a.pdf')).toBeTruthy();
  });
});
