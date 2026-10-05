import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { mailKeys } from '@/hooks/queries/use-mail-queries';
import {
  DraftAutosaver,
  offerDraftHandoff,
  takeDraftHandoff,
  type DraftChange,
  type DraftDiscardResult,
  type DraftFields,
  type DraftPersistence,
} from './draft-autosave';

// Matches the `subject` limit on /api/mail-drafts.
const MAX_SUBJECT_LENGTH = 998;

interface UseDraftAutosaveOptions {
  accountId: string | undefined;
  /** An already-saved draft that this compose session continues. */
  initialDraftId?: string | null;
  /** False while the compose surface is closed (the floating panel stays mounted). */
  active?: boolean;
  /** False while the form is not yet the user's (e.g. an opened draft still loading). */
  enabled?: boolean;
}

function toPayload(fields: DraftFields) {
  return {
    subject: fields.subject.slice(0, MAX_SUBJECT_LENGTH),
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    body: fields.body,
    htmlBody: fields.htmlBody,
    ...(fields.inReplyTo ? { inReplyTo: fields.inReplyTo } : {}),
  };
}

/**
 * Autosaves the compose form as a mail draft. Report every change through
 * `schedule`; the draft is created on the first real content and updated after
 * that. `saveNow` is the explicit save, `discard` removes the draft (after a send
 * or an explicit delete), and `handOff` passes the draft to the other compose
 * surface when the user minimizes or expands.
 */
export function useDraftAutosave({
  accountId,
  initialDraftId = null,
  active = true,
  enabled = true,
}: UseDraftAutosaveOptions) {
  const { mailDrafts } = useAppApi();
  const queryClient = useQueryClient();

  // The saver outlives renders, so it reads the changing inputs through refs.
  const accountIdRef = useRef(accountId);
  const enabledRef = useRef(enabled);
  const apiRef = useRef(mailDrafts);
  const queryClientRef = useRef(queryClient);
  const saverRef = useRef<DraftAutosaver | null>(null);
  const activeRef = useRef(false);
  useEffect(() => {
    accountIdRef.current = accountId;
    enabledRef.current = enabled;
    apiRef.current = mailDrafts;
    queryClientRef.current = queryClient;
  });

  const createSaver = useCallback((): DraftAutosaver => {
    const persistence: DraftPersistence = {
      create: async (targetAccountId, fields) => {
        const res = await apiRef.current.create({ accountId: targetAccountId, ...toPayload(fields) });
        return res.data.id;
      },
      update: async (draftId, fields) => {
        await apiRef.current.update(draftId, toPayload(fields));
      },
      remove: (draftId) => apiRef.current.delete(draftId),
    };
    const onChange = (change: DraftChange) => {
      void queryClientRef.current.invalidateQueries({ queryKey: mailKeys.drafts() });
      // Drafts count in the sidebar.
      if (change !== 'updated' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('mail-messages-changed'));
      }
    };
    return new DraftAutosaver({
      persistence,
      getAccountId: () => accountIdRef.current,
      draftId: initialDraftId,
      onChange,
    });
  }, [initialDraftId]);

  const getSaver = useCallback((): DraftAutosaver => {
    saverRef.current ??= createSaver();
    return saverRef.current;
  }, [createSaver]);

  // One saver per compose session. Cleanup is deferred a tick so a StrictMode
  // re-mount (cleanup immediately followed by setup) keeps the same saver.
  useEffect(() => {
    if (!active) return undefined;
    activeRef.current = true;
    if (!saverRef.current || saverRef.current.isClosed) {
      saverRef.current = takeDraftHandoff(accountIdRef.current) ?? createSaver();
    }
    return () => {
      activeRef.current = false;
      setTimeout(() => {
        if (activeRef.current) return;
        const saver = saverRef.current;
        saverRef.current = null;
        void saver?.finish();
      }, 0);
    };
  }, [active, createSaver]);

  const schedule = useCallback(
    (fields: DraftFields) => {
      if (!enabledRef.current) return;
      getSaver().schedule(fields);
    },
    [getSaver],
  );

  const saveNow = useCallback((fields: DraftFields): Promise<boolean> => getSaver().save(fields), [getSaver]);

  const discard = useCallback((): Promise<DraftDiscardResult> => getSaver().discard(), [getSaver]);

  const handOff = useCallback(() => {
    offerDraftHandoff(getSaver(), accountIdRef.current);
    saverRef.current = null;
  }, [getSaver]);

  return { schedule, saveNow, discard, handOff };
}
