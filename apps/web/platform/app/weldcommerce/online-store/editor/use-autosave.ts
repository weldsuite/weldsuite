/**
 * Saves the editor's changes on their own, about 600 ms after the last one:
 * the draft document with `PUT …/draft` (against the revision it was based
 * on), and each changed content page with `PATCH …/pages/:id`. One save runs
 * at a time; changes made meanwhile are saved right after it.
 *
 * A 409 `REVISION_CONFLICT` stops saving until the person chooses to load the
 * other version or keep theirs; a 400 `VALIDATION_ERROR` shows its fields and
 * waits for the next change.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import type { Section, SiteDocument } from '@weldsuite/storefront-theme/catalog';
import { revisionConflict, useSaveDraft, useUpdateStorePage, validationFields } from '@/hooks/queries/use-online-store-queries';
import type { EditorContent } from '../lib/document';
import { fieldErrorsAtom } from './editor-state';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'invalid' | 'conflict';

export const AUTOSAVE_DELAY_MS = 600;

interface AutosaveOptions {
  siteId: string;
  content: EditorContent;
  initialDocument: SiteDocument;
  initialRevision: number;
  /** False for a member who may only look: nothing is saved. */
  enabled: boolean;
  /** After every successful save (the preview reloads the draft). */
  onSaved: () => void;
  delay?: number;
}

export function useAutosave({ siteId, content, initialDocument, initialRevision, enabled, onSaved, delay = AUTOSAVE_DELAY_MS }: AutosaveOptions) {
  const saveDraft = useSaveDraft();
  const updatePage = useUpdateStorePage();
  const setFieldErrors = useSetAtom(fieldErrorsAtom);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);

  const revision = useRef(initialRevision);
  const savedDocument = useRef(initialDocument);
  /** A page's sections as last saved; first seen is as loaded. */
  const savedPages = useRef<Record<string, Section[]>>({});
  const latest = useRef(content);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const onSavedRef = useRef(onSaved);

  // Before the save effect below, which reads them.
  useEffect(() => {
    latest.current = content;
    onSavedRef.current = onSaved;
    for (const [pageId, sections] of Object.entries(content.pages)) {
      if (!(pageId in savedPages.current)) savedPages.current[pageId] = sections;
    }
  });

  const dirtyPages = (snapshot: EditorContent) =>
    Object.keys(snapshot.pages).filter((pageId) => pageId in savedPages.current && snapshot.pages[pageId] !== savedPages.current[pageId]);
  const isDirty = (snapshot: EditorContent) => snapshot.document !== savedDocument.current || dirtyPages(snapshot).length > 0;

  const run = useCallback(async (): Promise<boolean> => {
    const snapshot = latest.current;
    if (!isDirty(snapshot)) {
      setStatus('saved');
      return true;
    }
    setStatus('saving');
    try {
      if (snapshot.document !== savedDocument.current) {
        const res = await saveDraft.mutateAsync({ siteId, document: snapshot.document, revision: revision.current });
        revision.current = res.data.draftRevision;
        savedDocument.current = snapshot.document;
      }
      for (const pageId of dirtyPages(snapshot)) {
        const sections = snapshot.pages[pageId] ?? [];
        await updatePage.mutateAsync({ siteId, pageId, data: { sections } });
        savedPages.current[pageId] = sections;
      }
      setFieldErrors({});
      onSavedRef.current();
      setStatus(isDirty(latest.current) ? 'dirty' : 'saved');
      return true;
    } catch (err) {
      const conflict = revisionConflict(err);
      if (conflict !== null) {
        setConflictRevision(conflict);
        setStatus('conflict');
        return false;
      }
      const fields = validationFields(err);
      if (fields) {
        setFieldErrors(fields);
        setStatus('invalid');
        return false;
      }
      setStatus('error');
      return false;
    }
    // `isDirty` and `dirtyPages` read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, saveDraft.mutateAsync, updatePage.mutateAsync, setFieldErrors]);

  /** Saves now (after a save already running); resolves to whether everything is saved. */
  const save = useCallback(async (): Promise<boolean> => {
    while (inFlight.current) await inFlight.current;
    const promise = run();
    inFlight.current = promise;
    try {
      return await promise;
    } finally {
      if (inFlight.current === promise) inFlight.current = null;
    }
  }, [run]);

  const conflicted = status === 'conflict';
  useEffect(() => {
    if (!enabled || conflicted) return;
    if (!isDirty(content)) {
      // Undone back to what is saved (or started over from the server).
      setStatus((current) => (current === 'dirty' ? 'saved' : current));
      return;
    }
    setStatus((current) => (current === 'saving' ? current : 'dirty'));
    const timer = setTimeout(() => void save(), delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, enabled, conflicted, delay, save]);

  // Leaving the page with changes that are not saved yet asks first.
  const unsaved = status !== 'saved';
  useEffect(() => {
    if (!enabled || !unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [enabled, unsaved]);

  /** Starts over from a document the server has (a reload after a conflict, or a version copied to the draft). */
  const reset = useCallback(
    (document: SiteDocument, draftRevision: number) => {
      savedDocument.current = document;
      revision.current = draftRevision;
      setConflictRevision(null);
      setFieldErrors({});
      setStatus('saved');
    },
    [setFieldErrors],
  );

  /** Saves this editor's draft over the one saved elsewhere. */
  const overwrite = useCallback(async () => {
    if (conflictRevision !== null && conflictRevision >= 0) revision.current = conflictRevision;
    setConflictRevision(null);
    setStatus('dirty');
    return save();
  }, [conflictRevision, save]);

  return { status, save, reset, overwrite, revision };
}
