/**
 * Autosave of the builder's draft: what to send, and what a failed save means.
 *
 * The editor sends only what changed since the last save, together with the
 * `revision` it loaded. A stale revision gets 409 `REVISION_CONFLICT` and the
 * editor reloads the form with a notice; a definition the server refuses gets
 * 422 `INVALID_DEFINITION` (publish) or a validation error (save); anything
 * else is retried with the next edit.
 */

import { isApiError } from '@weldsuite/api-client';
import type { DefinitionIssue, FormDefinition } from '@weldsuite/forms-engine';
import type { FormDetail, FormSettings, UpdateFormInput } from '@weldsuite/app-api-client/schemas/weldforms';

/** The parts of a form the builder edits. */
export interface Draft {
  title: string;
  definition: FormDefinition;
  settings: FormSettings;
  themeId: string | null;
  access: FormDetail['access'];
  folderId: string | null;
}

export function draftFromForm(form: FormDetail): Draft {
  return {
    title: form.title,
    definition: form.definition,
    settings: form.settings,
    themeId: form.themeId,
    access: form.access,
    folderId: form.folderId,
  };
}

/** What differs between the last saved draft and the current one, as an update body (without `revision`). */
export function draftChanges(saved: Draft, current: Draft): Omit<UpdateFormInput, 'revision'> | null {
  const changes: Omit<UpdateFormInput, 'revision'> = {};
  if (current.title !== saved.title) changes.title = current.title;
  if (current.definition !== saved.definition && !sameJson(current.definition, saved.definition)) changes.definition = current.definition;
  if (current.settings !== saved.settings) {
    const partial = changedKeys(saved.settings, current.settings);
    if (Object.keys(partial).length > 0) changes.settings = partial;
  }
  if (current.themeId !== saved.themeId) changes.themeId = current.themeId;
  if (current.access !== saved.access) changes.access = current.access;
  if (current.folderId !== saved.folderId) changes.folderId = current.folderId;
  return Object.keys(changes).length === 0 ? null : changes;
}

function changedKeys<T extends object>(before: T, after: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(after) as Array<keyof T>) {
    if (!sameJson(before[key], after[key])) out[key] = after[key];
  }
  return out;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export type SaveFailure =
  /** Someone else saved first: reload and tell the author. */
  | { kind: 'conflict' }
  /** The server refused the content. `issues` are the engine's, when it sent them. */
  | { kind: 'invalid'; issues: DefinitionIssue[]; message: string }
  /** The form is gone, or no longer ours. */
  | { kind: 'gone' }
  /** Offline or a server error: keep the draft, try again on the next edit. */
  | { kind: 'retry'; message: string };

function errorCode(err: unknown): string | undefined {
  if (!isApiError(err)) return undefined;
  const body = err.body as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

/** The engine's issues from a 422 `INVALID_DEFINITION`, wherever the server put them. */
export function issuesFromError(err: unknown): DefinitionIssue[] {
  if (!isApiError(err)) return [];
  const body = err.body as { error?: { details?: unknown } } | undefined;
  const details = body?.error?.details;
  const list = Array.isArray(details) ? details : (details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is DefinitionIssue => typeof item === 'object' && item !== null && typeof (item as DefinitionIssue).code === 'string' && typeof (item as DefinitionIssue).message === 'string',
  );
}

export function classifySaveError(err: unknown): SaveFailure {
  if (isApiError(err)) {
    if (err.status === 409 || errorCode(err) === 'REVISION_CONFLICT') return { kind: 'conflict' };
    if (err.status === 404) return { kind: 'gone' };
    if (err.status === 422 || err.status === 400) return { kind: 'invalid', issues: issuesFromError(err), message: err.message };
    return { kind: 'retry', message: err.message };
  }
  return { kind: 'retry', message: err instanceof Error ? err.message : String(err) };
}

/** Publishing: `NO_QUESTIONS` is its own case; `INVALID_DEFINITION` carries issues. */
export type PublishFailure = { kind: 'no_questions' } | { kind: 'invalid'; issues: DefinitionIssue[]; message: string } | { kind: 'other'; message: string };

export function classifyPublishError(err: unknown): PublishFailure {
  if (isApiError(err)) {
    const code = errorCode(err);
    if (code === 'NO_QUESTIONS') return { kind: 'no_questions' };
    if (code === 'INVALID_DEFINITION' || err.status === 422) return { kind: 'invalid', issues: issuesFromError(err), message: err.message };
    return { kind: 'other', message: err.message };
  }
  return { kind: 'other', message: err instanceof Error ? err.message : String(err) };
}

export type SaveOutcome =
  /** Nothing differed from the last save. */
  | { kind: 'noop' }
  /** Saved: the server's form, and the draft that went out (the editor's new "last saved"). */
  | { kind: 'saved'; form: FormDetail; savedDraft: Draft }
  /** Someone saved first: the server's current form, to replace the editor's copy. */
  | { kind: 'conflict'; form: FormDetail | null }
  | { kind: 'invalid'; issues: DefinitionIssue[]; message: string }
  | { kind: 'gone' }
  | { kind: 'retry'; message: string };

export interface PerformSaveArgs {
  /** The draft as last saved (or loaded). */
  saved: Draft;
  /** The draft now. */
  current: Draft;
  /** The revision the editor holds. */
  revision: number;
  send: (input: UpdateFormInput) => Promise<FormDetail>;
  /** Reads the form from the server; used after a conflict. */
  reload: () => Promise<FormDetail>;
}

/**
 * One autosave round: send what changed with the held revision and turn the
 * answer into an outcome. A conflict reloads the form so the caller can adopt
 * it; the unsaved edits are dropped (the author is told).
 */
export async function performSave({ saved, current, revision, send, reload }: PerformSaveArgs): Promise<SaveOutcome> {
  const changes = draftChanges(saved, current);
  if (!changes) return { kind: 'noop' };
  try {
    const form = await send({ ...changes, revision });
    return { kind: 'saved', form, savedDraft: current };
  } catch (err) {
    const failure = classifySaveError(err);
    if (failure.kind === 'conflict') {
      try {
        return { kind: 'conflict', form: await reload() };
      } catch {
        return { kind: 'conflict', form: null };
      }
    }
    return failure;
  }
}
