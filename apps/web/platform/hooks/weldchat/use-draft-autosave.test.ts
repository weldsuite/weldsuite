import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { DraftItem } from '@weldsuite/core-api-client/schemas/weldchat-drafts';

const mocks = vi.hoisted(() => ({
  upsertAsync: vi.fn(),
  deleteAsync: vi.fn(),
  drafts: [] as unknown[],
}));

vi.mock('@/hooks/queries/use-weldchat-extras-queries', () => ({
  useChatDrafts: () => ({ data: { data: mocks.drafts } }),
  useUpsertDraft: () => ({ mutateAsync: mocks.upsertAsync }),
  useDeleteDraft: () => ({ mutateAsync: mocks.deleteAsync }),
}));

import { useDraftAutosave } from './use-draft-autosave';

const CHANNEL = 'ch_1';

function render(initialContent: string, threadParentMessageId?: string, onRestore?: (content: string) => void) {
  return renderHook(
    ({ content, channelId = CHANNEL }: { content: string; channelId?: string }) =>
      useDraftAutosave({ channelId, threadParentMessageId, content, attachments: [], onRestore }),
    { initialProps: { content: initialContent } as { content: string; channelId?: string } },
  );
}

const saved = (id: string) => ({ data: { id } });

beforeEach(() => {
  vi.useFakeTimers();
  mocks.upsertAsync.mockReset();
  mocks.deleteAsync.mockReset();
  mocks.upsertAsync.mockResolvedValue(saved('d_new'));
  mocks.deleteAsync.mockResolvedValue(undefined);
  mocks.drafts = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDraftAutosave', () => {
  it('never saves an empty draft just because a composer mounted', async () => {
    render('');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.upsertAsync).not.toHaveBeenCalled();
    expect(mocks.deleteAsync).not.toHaveBeenCalled();
  });

  it('saves typed text after the debounce', async () => {
    const { rerender } = render('');
    rerender({ content: 'hello' });
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.upsertAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.upsertAsync).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAsync).toHaveBeenCalledWith({
      channelId: CHANNEL,
      threadParentMessageId: undefined,
      content: 'hello',
      attachments: undefined,
    });
  });

  it('deletes the draft that exists when the composer is emptied, without writing an empty one', async () => {
    mocks.drafts = [{ id: 'd_1', channelId: CHANNEL, threadParentMessageId: null, content: 'old', attachments: null }];
    mocks.upsertAsync.mockResolvedValue(saved('d_1'));
    const { rerender } = render('old');
    await vi.advanceTimersByTimeAsync(600);
    mocks.upsertAsync.mockClear();

    rerender({ content: '' });
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.deleteAsync).toHaveBeenCalledWith('d_1');
    expect(mocks.upsertAsync).not.toHaveBeenCalled();
  });

  it('ends with no draft when send runs while the save is still in flight', async () => {
    let finishSave: (value: { data: { id: string } }) => void = () => undefined;
    mocks.upsertAsync.mockImplementationOnce(
      () => new Promise((resolve) => { finishSave = resolve; }),
    );

    const { result, rerender } = render('');
    rerender({ content: 'a reply' });
    await vi.advanceTimersByTimeAsync(600); // the create is now in flight
    expect(mocks.upsertAsync).toHaveBeenCalledTimes(1);

    // Send: the composer clears its text and deletes the draft.
    result.current.deleteDraft();
    rerender({ content: '' });
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.deleteAsync).not.toHaveBeenCalled(); // the id isn't known yet

    // The create lands late: it must be followed by a delete of that very draft.
    finishSave(saved('d_late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.deleteAsync).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAsync).toHaveBeenCalledWith('d_late');
    // …and nothing ever upserts an empty draft.
    for (const [input] of mocks.upsertAsync.mock.calls) {
      expect((input as { content: string }).content).not.toBe('');
    }
  });

  it('drops a save that was queued but not started when send runs', async () => {
    let finishFirst: (value: { data: { id: string } }) => void = () => undefined;
    mocks.upsertAsync.mockImplementationOnce(
      () => new Promise((resolve) => { finishFirst = resolve; }),
    );

    const { result, rerender } = render('');
    rerender({ content: 'one' });
    await vi.advanceTimersByTimeAsync(600); // first save in flight
    rerender({ content: 'one two' });
    await vi.advanceTimersByTimeAsync(600); // second save queued behind it

    result.current.deleteDraft();
    finishFirst(saved('d_1'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.upsertAsync).toHaveBeenCalledTimes(1); // the queued save never ran
    expect(mocks.deleteAsync).toHaveBeenCalledWith('d_1');
  });

  it('cancels a pending debounce when the draft is deleted', async () => {
    const { result, rerender } = render('');
    rerender({ content: 'typed then sent quickly' });
    await vi.advanceTimersByTimeAsync(200);
    result.current.deleteDraft();
    rerender({ content: '' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.upsertAsync).not.toHaveBeenCalled();
    expect(mocks.deleteAsync).not.toHaveBeenCalled();
  });

  it('deletes by the id of the matching draft after send', async () => {
    mocks.drafts = [
      { id: 'd_thread', channelId: CHANNEL, threadParentMessageId: 'msg_p', content: 'x', attachments: null },
      { id: 'd_chan', channelId: CHANNEL, threadParentMessageId: null, content: 'y', attachments: null },
    ] satisfies Array<Partial<DraftItem>>;
    const { result } = render('', 'msg_p');
    result.current.deleteDraft();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.deleteAsync).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAsync).toHaveBeenCalledWith('d_thread');
  });

  it('flushes unsent text when the composer unmounts', async () => {
    const { rerender, unmount } = render('');
    rerender({ content: 'unsent' });
    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.upsertAsync).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAsync.mock.calls[0][0]).toMatchObject({ content: 'unsent' });
  });

  it('does not flush on unmount when there is nothing to save', async () => {
    const { unmount } = render('');
    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.upsertAsync).not.toHaveBeenCalled();
  });

  it('survives a failed save and keeps working', async () => {
    mocks.upsertAsync.mockRejectedValueOnce(new Error('boom'));
    const { rerender } = render('');
    rerender({ content: 'first' });
    await vi.advanceTimersByTimeAsync(600);
    rerender({ content: 'second' });
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.upsertAsync).toHaveBeenCalledTimes(2);
  });

  it('never restores a draft this composer created and deleted (stale list after send)', async () => {
    const onRestore = vi.fn();
    mocks.upsertAsync.mockResolvedValue(saved('d_1'));
    const { result, rerender } = render('', undefined, onRestore);
    rerender({ content: 'sent text' });
    await vi.advanceTimersByTimeAsync(600); // D1 created

    // Enter before the drafts list refetch returns: delete D1, clear the composer.
    result.current.deleteDraft();
    rerender({ content: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.deleteAsync).toHaveBeenCalledWith('d_1');

    // The stale refetch still lists D1.
    mocks.drafts = [{ id: 'd_1', channelId: CHANNEL, threadParentMessageId: null, content: 'sent text', attachments: null }];
    rerender({ content: '' });
    await vi.advanceTimersByTimeAsync(600);
    expect(onRestore).not.toHaveBeenCalled();
    expect(mocks.upsertAsync).toHaveBeenCalledTimes(1);
  });

  it('restores a draft that existed when the context was resolved, once', async () => {
    const onRestore = vi.fn();
    mocks.drafts = [{ id: 'd_0', channelId: CHANNEL, threadParentMessageId: null, content: 'old draft', attachments: null }];
    const { rerender } = render('', undefined, onRestore);
    rerender({ content: '' });
    await vi.advanceTimersByTimeAsync(600);
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith('old draft', []);
  });

  describe('when the channel changes under a mounted composer', () => {
    it('does not delete the previous channel draft when sending in the new one, and restores the new one', async () => {
      const onRestore = vi.fn();
      mocks.drafts = [
        { id: 'd_a', channelId: 'ch_a', threadParentMessageId: null, content: 'A draft', attachments: null },
        { id: 'd_b', channelId: 'ch_b', threadParentMessageId: null, content: 'B draft', attachments: null },
      ];
      const { result, rerender } = render('', undefined, onRestore);
      rerender({ content: '', channelId: 'ch_a' });
      expect(onRestore).toHaveBeenLastCalledWith('A draft', []);

      onRestore.mockClear();
      rerender({ content: '', channelId: 'ch_b' });
      expect(onRestore).toHaveBeenCalledWith('B draft', []);

      result.current.deleteDraft();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.deleteAsync).toHaveBeenCalledTimes(1);
      expect(mocks.deleteAsync).toHaveBeenCalledWith('d_b');
    });

    it('does not carry the previous channel draft id into a channel with no draft', async () => {
      mocks.drafts = [{ id: 'd_a', channelId: 'ch_a', threadParentMessageId: null, content: 'A', attachments: null }];
      const { result, rerender } = render('', undefined);
      rerender({ content: '', channelId: 'ch_a' });
      rerender({ content: '', channelId: 'ch_b' });
      result.current.deleteDraft();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.deleteAsync).not.toHaveBeenCalled();
    });

    it('flushes unsent text to the channel it was typed in', async () => {
      const { rerender } = render('');
      rerender({ content: 'typed in A', channelId: 'ch_a' });
      rerender({ content: 'typed in A', channelId: 'ch_b' });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.upsertAsync).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'ch_a', content: 'typed in A' }));
    });
  });
});
