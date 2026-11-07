/**
 * Inbox translation state shared by the header toggle, the timeline and the
 * composer (they don't share a parent that would otherwise hold it):
 *
 * - which conversations the agent turned "Translate" on for;
 * - per conversation, the draft the composer translated: what the agent
 *   wrote, so the reply sent with that translation keeps it in metadata.
 *
 * In memory only: a reload starts with translation off.
 */

import { useCallback } from 'react';
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { isApiError } from '@weldsuite/api-client';
import { getLocale, getTranslations } from '@/lib/i18n';
import { isFeatureAvailable } from '@/lib/edition';
import { usePermissions } from '@weldsuite/permissions/react';
import type { DeskReplyTranslation } from '@/hooks/queries/use-desk-translation-queries';

const translateOnAtom = atom<Record<string, boolean>>({});

/** The composer's translated draft: what the agent wrote, and what it became. */
export interface DraftTranslation extends DeskReplyTranslation {
  translated: string;
}

const draftTranslationAtom = atom<Record<string, DraftTranslation | undefined>>({});

/** Translation needs the AI (Global only) and the right to work the conversation. */
export function useDeskTranslationAvailable(): boolean {
  const { can } = usePermissions();
  return isFeatureAvailable('desk-ai') && can('conversations:update');
}

export function useTranslateOn(conversationId: string): [boolean, (on: boolean) => void] {
  const [state, setState] = useAtom(translateOnAtom);
  const set = useCallback(
    (on: boolean) => setState((prev) => ({ ...prev, [conversationId]: on })),
    [conversationId, setState],
  );
  return [state[conversationId] === true, set];
}

export function useDraftTranslation(conversationId: string) {
  const drafts = useAtomValue(draftTranslationAtom);
  const setDrafts = useSetAtom(draftTranslationAtom);
  const set = useCallback(
    (draft: DraftTranslation | undefined) => setDrafts((prev) => ({ ...prev, [conversationId]: draft })),
    [conversationId, setDrafts],
  );
  return [drafts[conversationId], set] as const;
}

/**
 * For the send path: the `translation` to send with a reply, taken (and
 * cleared) from the composer's translated draft. Nothing for a note.
 */
export function useTakeDraftTranslation(conversationId: string) {
  const store = useStore();
  return useCallback(
    (kind: 'message' | 'note'): { translation?: DeskReplyTranslation } => {
      const draft = store.get(draftTranslationAtom)[conversationId];
      if (!draft) return {};
      store.set(draftTranslationAtom, (prev) => ({ ...prev, [conversationId]: undefined }));
      if (kind !== 'message') return {};
      return {
        translation: { original: draft.original, sourceLocale: draft.sourceLocale, targetLocale: draft.targetLocale },
      };
    },
    [conversationId, store],
  );
}

/** The agent's language: the UI locale. */
export function agentLocale(): string {
  return getLocale();
}

/** "German" (in the agent's language) for `de`; the code when the browser can't name it. */
export function languageLabel(code: string | null | undefined): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Two tags name the same language when their primary subtags match (`en`, `en-GB`). */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.split('-')[0]!.toLowerCase() === b.split('-')[0]!.toLowerCase();
}

/** The message a failed translation shows: no credits, no AI, or a plain failure. */
export function translationErrorMessage(err: unknown): string {
  const t = getTranslations('helpdesk').translation;
  if (isApiError(err) && err.status === 402) return t.noCredits;
  if (isApiError(err) && err.status === 503) return t.unavailable;
  return t.failed;
}
