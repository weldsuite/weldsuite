/**
 * The builder's state for one form: the draft being edited (definition,
 * settings, title, theme, access), its undo history, autosave and the
 * definition issues.
 *
 * The editor owns a copy of the draft so typing never waits on the server and
 * a realtime refetch can't overwrite it. Autosave sends what changed with the
 * revision the editor loaded (`performSave`); a 409 reloads the form and tells
 * the author. Part 2's pages (share, results, integrations) can read the same
 * context for the form and its `permissions`, or just use `useForm(id)`.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { validateDefinition, type DefinitionIssue, type FormDefinition } from '@weldsuite/forms-engine';
import type { FormDetail, FormSettings } from '@weldsuite/app-api-client/schemas/weldforms';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { weldformsKeys } from '@/hooks/queries/use-weldforms-queries';
import { canRedo, canUndo, commit, createHistory, redo as redoHistory, undo as undoHistory, type History } from '../lib/draft-history';
import { draftChanges, draftFromForm, performSave, type Draft } from '../lib/autosave';
import { issuesByBlock } from '../lib/issues';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** What the center and right panels show: the welcome screen, a block, an ending or nothing. */
export type Selection = { kind: 'welcome' } | { kind: 'block'; id: string } | { kind: 'ending'; id: string } | null;

export const AUTOSAVE_DELAY_MS = 800;

export interface FormEditor {
  form: FormDetail;
  draft: Draft;
  definition: FormDefinition;
  settings: FormSettings;
  /** The form is editable by this member. */
  canEdit: boolean;
  saveState: SaveState;
  /** Message of the last failed save, when `saveState` is `error`. */
  saveError: string | null;
  issues: DefinitionIssue[];
  issuesByBlock: Map<string, DefinitionIssue[]>;
  selection: Selection;
  select: (selection: Selection) => void;
  /** Edits the definition; edits with the same `coalesceKey` close together are one undo step. */
  editDefinition: (recipe: (def: FormDefinition) => FormDefinition, coalesceKey?: string) => void;
  editDraft: (recipe: (draft: Draft) => Draft, coalesceKey?: string) => void;
  setTitle: (title: string) => void;
  patchSettings: (patch: Partial<FormSettings>) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Saves now (publish waits for it). Resolves false when the draft could not be saved. */
  flush: () => Promise<boolean>;
  /** Replaces the editor's copy with the server's (after discarding changes, a conflict, …). */
  adopt: (form: FormDetail) => void;
  /**
   * Takes the revision of a lifecycle call (publish, close, reopen) that may bump it without touching the draft,
   * so the next autosave doesn't answer 409 for it.
   */
  acceptRevision: (revision: number) => void;
}

const FormEditorContext = createContext<FormEditor | null>(null);

export function useFormEditor(): FormEditor {
  const value = useContext(FormEditorContext);
  if (!value) throw new Error('useFormEditor must be used inside <FormEditorProvider>');
  return value;
}

/** Null outside the builder shell, for pages that also render elsewhere. */
export function useOptionalFormEditor(): FormEditor | null {
  return useContext(FormEditorContext);
}

interface ProviderProps {
  form: FormDetail;
  children: ReactNode;
}

export function FormEditorProvider({ form, children }: Readonly<ProviderProps>) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const [history, setHistory] = useState<History<Draft>>(() => createHistory(draftFromForm(form)));
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);

  const savedRef = useRef<Draft>(history.present);
  const revisionRef = useRef(form.revision);
  const historyRef = useRef(history);
  historyRef.current = history;
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formIdRef = useRef(form.id);

  const canEdit = form.permissions.edit;

  const adopt = useCallback((next: FormDetail) => {
    const draft = draftFromForm(next);
    savedRef.current = draft;
    revisionRef.current = next.revision;
    setHistory(createHistory(draft));
    setSaveState('saved');
    setSaveError(null);
  }, []);

  // A different form (navigating between forms reuses the provider): start over.
  useEffect(() => {
    if (formIdRef.current === form.id) return;
    formIdRef.current = form.id;
    adopt(form);
    setSelection(null);
  }, [form, adopt]);

  // Someone else saved (a realtime refetch brought a newer revision) and we hold no edits: take it.
  useEffect(() => {
    if (form.id !== formIdRef.current || form.revision <= revisionRef.current) return;
    if (draftChanges(savedRef.current, historyRef.current.present) === null) adopt(form);
  }, [form, adopt]);

  const acceptRevision = useCallback((revision: number) => {
    if (revision > revisionRef.current) revisionRef.current = revision;
  }, []);

  const runSave = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current) await inFlightRef.current;
    const current = historyRef.current.present;
    if (draftChanges(savedRef.current, current) === null) {
      setSaveState('saved');
      return true;
    }
    const id = formIdRef.current;
    setSaveState('saving');
    const job = (async () => {
      const outcome = await performSave({
        saved: savedRef.current,
        current,
        revision: revisionRef.current,
        send: async (input) => (await weldforms.update(id, input)).data,
        reload: async () => (await weldforms.get(id)).data,
      });
      switch (outcome.kind) {
        case 'noop':
          setSaveState('saved');
          return true;
        case 'saved': {
          savedRef.current = outcome.savedDraft;
          revisionRef.current = outcome.form.revision;
          queryClient.setQueryData(weldformsKeys.form(id), { data: outcome.form });
          void queryClient.invalidateQueries({ queryKey: weldformsKeys.lists() });
          // More edits arrived while saving: leave "dirty" so the next round runs.
          setSaveState(draftChanges(savedRef.current, historyRef.current.present) === null ? 'saved' : 'dirty');
          setSaveError(null);
          return true;
        }
        case 'conflict':
          if (outcome.form) {
            queryClient.setQueryData(weldformsKeys.form(id), { data: outcome.form });
            adopt(outcome.form);
          } else {
            setSaveState('error');
            setSaveError(t.weldforms.editor.saveFailed);
          }
          toast.warning(t.weldforms.editor.conflict);
          return false;
        case 'invalid':
        case 'retry':
          setSaveState('error');
          setSaveError(outcome.message);
          return false;
        case 'gone':
          setSaveState('error');
          setSaveError(t.weldforms.editor.gone);
          return false;
      }
    })();
    inFlightRef.current = job;
    try {
      return await job;
    } finally {
      if (inFlightRef.current === job) inFlightRef.current = null;
    }
  }, [weldforms, queryClient, adopt, t]);

  // Debounced autosave whenever the draft differs from the last save.
  useEffect(() => {
    if (!canEdit) return;
    if (draftChanges(savedRef.current, history.present) === null) return;
    setSaveState((state) => (state === 'saving' ? state : 'dirty'));
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void runSave(), AUTOSAVE_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [history.present, canEdit, runSave]);

  // Leaving with unsaved edits: try to save, and ask the browser to warn.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (draftChanges(savedRef.current, historyRef.current.present) === null) return;
      void runSave();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (draftChanges(savedRef.current, historyRef.current.present) !== null) void runSave();
    };
  }, [runSave]);

  const editDraft = useCallback(
    (recipe: (draft: Draft) => Draft, coalesceKey?: string) => {
      if (!canEdit) return;
      setHistory((h) => commit(h, recipe(h.present), { coalesceKey }));
    },
    [canEdit],
  );

  const editDefinition = useCallback(
    (recipe: (def: FormDefinition) => FormDefinition, coalesceKey?: string) => {
      editDraft((draft) => {
        const definition = recipe(draft.definition);
        return definition === draft.definition ? draft : { ...draft, definition };
      }, coalesceKey);
    },
    [editDraft],
  );

  const setTitle = useCallback((title: string) => editDraft((d) => (d.title === title ? d : { ...d, title }), 'title'), [editDraft]);

  const patchSettings = useCallback(
    (patch: Partial<FormSettings>) => editDraft((d) => ({ ...d, settings: { ...d.settings, ...patch } }), `settings:${Object.keys(patch).join(',')}`),
    [editDraft],
  );

  const undo = useCallback(() => canEdit && setHistory((h) => undoHistory(h)), [canEdit]);
  const redo = useCallback(() => canEdit && setHistory((h) => redoHistory(h)), [canEdit]);

  const draft = history.present;
  const issues = useMemo(() => validateDefinition(draft.definition), [draft.definition]);
  const byBlock = useMemo(() => issuesByBlock(draft.definition, issues), [draft.definition, issues]);

  const value = useMemo<FormEditor>(
    () => ({
      form,
      draft,
      definition: draft.definition,
      settings: draft.settings,
      canEdit,
      saveState,
      saveError,
      issues,
      issuesByBlock: byBlock,
      selection,
      select: setSelection,
      editDefinition,
      editDraft,
      setTitle,
      patchSettings,
      undo,
      redo,
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      flush: runSave,
      adopt,
      acceptRevision,
    }),
    [form, draft, canEdit, saveState, saveError, issues, byBlock, selection, editDefinition, editDraft, setTitle, patchSettings, undo, redo, history, runSave, adopt, acceptRevision],
  );

  return <FormEditorContext.Provider value={value}>{children}</FormEditorContext.Provider>;
}
