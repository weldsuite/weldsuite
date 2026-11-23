import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { defaultSiteDocument, type SiteDocument } from '@weldsuite/storefront-theme/catalog';
import type { EditorContent } from '../lib/document';
import { fieldErrorsAtom } from './editor-state';

const api = vi.hoisted(() => ({ saveDraft: vi.fn(), updatePage: vi.fn() }));

vi.mock('@/hooks/queries/use-online-store-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/queries/use-online-store-queries')>();
  return {
    revisionConflict: actual.revisionConflict,
    validationFields: actual.validationFields,
    useSaveDraft: () => ({ mutateAsync: api.saveDraft }),
    useUpdateStorePage: () => ({ mutateAsync: api.updatePage }),
  };
});

import { AUTOSAVE_DELAY_MS, useAutosave } from './use-autosave';

const initial = defaultSiteDocument();
const titled = (title: string): SiteDocument => ({ ...initial, seo: { title } });
const apiError = (status: number, code: string, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { status, body: { error: { code, message: code, details } } });

let store: ReturnType<typeof createStore>;

function setup(onSaved = vi.fn(), enabled = true) {
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const hook = renderHook(
    ({ content }: { content: EditorContent }) =>
      useAutosave({ siteId: 'sfs_1', content, initialDocument: initial, initialRevision: 3, enabled, onSaved }),
    { wrapper, initialProps: { content: { document: initial, pages: {} } } },
  );
  return { ...hook, onSaved };
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  store = createStore();
  api.saveDraft.mockReset();
  api.updatePage.mockReset();
  api.saveDraft.mockImplementation(async ({ revision }: { revision: number }) => ({ data: { draftRevision: revision + 1, draftUpdatedAt: 'now' } }));
  api.updatePage.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutosave', () => {
  it('saves the draft a moment after the last change, against the revision it was based on, then tells the preview', async () => {
    const { result, rerender, onSaved } = setup();
    expect(result.current.status).toBe('saved');
    rerender({ content: { document: titled('A'), pages: {} } });
    expect(result.current.status).toBe('dirty');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    rerender({ content: { document: titled('AB'), pages: {} } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(api.saveDraft).not.toHaveBeenCalled();
    await settle();
    expect(api.saveDraft).toHaveBeenCalledTimes(1);
    expect(api.saveDraft).toHaveBeenCalledWith({ siteId: 'sfs_1', document: titled('AB'), revision: 3 });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('saved');

    // The next save uses the revision the server answered.
    rerender({ content: { document: titled('ABC'), pages: {} } });
    await settle();
    expect(api.saveDraft).toHaveBeenLastCalledWith({ siteId: 'sfs_1', document: titled('ABC'), revision: 4 });
  });

  it('saves a changed content page with its own call', async () => {
    const { rerender } = setup();
    rerender({ content: { document: initial, pages: { pg_1: [] } } });
    await settle();
    expect(api.updatePage).not.toHaveBeenCalled();
    const sections = [{ id: 'text', type: 'rich-text', settings: {} }];
    rerender({ content: { document: initial, pages: { pg_1: sections } } });
    await settle();
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.updatePage).toHaveBeenCalledWith({ siteId: 'sfs_1', pageId: 'pg_1', data: { sections } });
  });

  it('stops on a revision conflict until the person keeps theirs, then saves over the current revision', async () => {
    api.saveDraft.mockRejectedValueOnce(apiError(409, 'REVISION_CONFLICT', { currentRevision: 9 }));
    const { result, rerender, onSaved } = setup();
    rerender({ content: { document: titled('Mine'), pages: {} } });
    await settle();
    expect(result.current.status).toBe('conflict');
    expect(onSaved).not.toHaveBeenCalled();

    // Further edits wait for the choice.
    rerender({ content: { document: titled('Mine too'), pages: {} } });
    await settle();
    expect(api.saveDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.overwrite();
    });
    expect(api.saveDraft).toHaveBeenLastCalledWith({ siteId: 'sfs_1', document: titled('Mine too'), revision: 9 });
    expect(result.current.status).toBe('saved');
  });

  it('starts over from the server’s version after a reload', async () => {
    api.saveDraft.mockRejectedValueOnce(apiError(409, 'REVISION_CONFLICT', { currentRevision: 9 }));
    const { result, rerender } = setup();
    rerender({ content: { document: titled('Mine'), pages: {} } });
    await settle();
    const theirs = titled('Theirs');
    act(() => result.current.reset(theirs, 9));
    rerender({ content: { document: theirs, pages: {} } });
    await settle();
    expect(result.current.status).toBe('saved');
    expect(api.saveDraft).toHaveBeenCalledTimes(1);
    rerender({ content: { document: titled('Theirs, edited'), pages: {} } });
    await settle();
    expect(api.saveDraft).toHaveBeenLastCalledWith({ siteId: 'sfs_1', document: titled('Theirs, edited'), revision: 9 });
  });

  it('keeps the field errors of a refused save for the forms, and clears them after the next save', async () => {
    api.saveDraft.mockRejectedValueOnce(apiError(400, 'VALIDATION_ERROR', { fields: { 'seo.title': 'Too long' } }));
    const { result, rerender } = setup();
    rerender({ content: { document: titled('x'.repeat(10)), pages: {} } });
    await settle();
    expect(result.current.status).toBe('invalid');
    expect(store.get(fieldErrorsAtom)).toEqual({ 'seo.title': 'Too long' });
    rerender({ content: { document: titled('ok'), pages: {} } });
    await settle();
    expect(result.current.status).toBe('saved');
    expect(store.get(fieldErrorsAtom)).toEqual({});
  });

  it('says a save failed and saves again on request', async () => {
    api.saveDraft.mockRejectedValueOnce(new Error('offline'));
    const { result, rerender } = setup();
    rerender({ content: { document: titled('A'), pages: {} } });
    await settle();
    expect(result.current.status).toBe('error');
    await act(async () => {
      expect(await result.current.save()).toBe(true);
    });
    expect(result.current.status).toBe('saved');
  });

  it('saves nothing for a member who may only look', async () => {
    const { rerender } = setup(vi.fn(), false);
    rerender({ content: { document: titled('A'), pages: {} } });
    await settle();
    expect(api.saveDraft).not.toHaveBeenCalled();
  });
});
