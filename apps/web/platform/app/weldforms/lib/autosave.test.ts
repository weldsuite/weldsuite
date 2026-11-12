import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import { createBlankDefinition, createField } from '@weldsuite/forms-engine';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { classifyPublishError, classifySaveError, draftChanges, issuesFromError, performSave, type Draft } from './autosave';

const BASE = createBlankDefinition();

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    title: 'Form',
    definition: BASE,
    settings: {
      respondentMode: 'anyone',
      onePerRespondent: false,
      allowEdit: false,
      hideMemberIdentity: false,
      collectPartial: false,
      opensAt: null,
      closesAt: null,
      responseLimit: null,
      closedMessage: null,
      allowedEmbedDomains: [],
      sendReceipt: false,
    },
    themeId: null,
    access: 'workspace',
    folderId: null,
    ...overrides,
  };
}

const serverForm = (revision: number) => ({ id: 'frm_1', revision }) as unknown as FormDetail;
const apiError = (status: number, code?: string, details?: unknown) => new ApiError('x', status, { error: { code, message: 'x', details } });

describe('draftChanges', () => {
  it('is null when nothing differs', () => {
    const d = draft();
    expect(draftChanges(d, { ...d })).toBeNull();
    expect(draftChanges(d, draft({ definition: structuredClone(d.definition) }))).toBeNull();
  });

  it('sends only what changed, with only the changed settings', () => {
    const saved = draft();
    const current = draft({ title: 'New', settings: { ...saved.settings, collectPartial: true }, themeId: 'fth_1' });
    expect(draftChanges(saved, current)).toEqual({ title: 'New', settings: { collectPartial: true }, themeId: 'fth_1' });
  });

  it('sends the whole definition when it changed', () => {
    const saved = draft();
    const definition = { ...saved.definition, blocks: [createField('email', { ref: 'e' })] };
    expect(draftChanges(saved, draft({ definition }))).toEqual({ definition });
  });
});

describe('performSave', () => {
  it('does nothing for an unchanged draft', async () => {
    const send = vi.fn();
    const d = draft();
    expect(await performSave({ saved: d, current: d, revision: 3, send, reload: vi.fn() })).toEqual({ kind: 'noop' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the held revision and reports the draft that went out', async () => {
    const send = vi.fn().mockResolvedValue(serverForm(4));
    const saved = draft();
    const current = draft({ title: 'Changed' });
    const outcome = await performSave({ saved, current, revision: 3, send, reload: vi.fn() });
    expect(send).toHaveBeenCalledWith({ title: 'Changed', revision: 3 });
    expect(outcome).toMatchObject({ kind: 'saved', savedDraft: current });
    expect(outcome.kind === 'saved' && outcome.form.revision).toBe(4);
  });

  it('reloads the form after a revision conflict', async () => {
    const reload = vi.fn().mockResolvedValue(serverForm(9));
    const outcome = await performSave({
      saved: draft(),
      current: draft({ title: 'Mine' }),
      revision: 3,
      send: vi.fn().mockRejectedValue(apiError(409, 'REVISION_CONFLICT')),
      reload,
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(outcome.kind === 'conflict' && outcome.form?.revision).toBe(9);
  });

  it('still reports a conflict when the reload fails', async () => {
    const outcome = await performSave({
      saved: draft(),
      current: draft({ title: 'Mine' }),
      revision: 3,
      send: vi.fn().mockRejectedValue(apiError(409)),
      reload: vi.fn().mockRejectedValue(new Error('offline')),
    });
    expect(outcome).toEqual({ kind: 'conflict', form: null });
  });

  it('keeps the draft for the next try when the network fails', async () => {
    const outcome = await performSave({
      saved: draft(),
      current: draft({ title: 'Mine' }),
      revision: 3,
      send: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      reload: vi.fn(),
    });
    expect(outcome.kind).toBe('retry');
  });
});

describe('error classification', () => {
  it('maps statuses to save failures', () => {
    expect(classifySaveError(apiError(409)).kind).toBe('conflict');
    expect(classifySaveError(apiError(404)).kind).toBe('gone');
    expect(classifySaveError(apiError(422)).kind).toBe('invalid');
    expect(classifySaveError(apiError(500)).kind).toBe('retry');
  });

  it('reads the engine issues from a 422 INVALID_DEFINITION', () => {
    const issues = [{ code: 'duplicate_ref', message: 'dup', path: 'blocks.1.ref' }];
    expect(issuesFromError(apiError(422, 'INVALID_DEFINITION', issues))).toEqual(issues);
    expect(issuesFromError(apiError(422, 'INVALID_DEFINITION', { issues }))).toEqual(issues);
    expect(issuesFromError(apiError(422, 'INVALID_DEFINITION', 'nope'))).toEqual([]);
    expect(classifyPublishError(apiError(422, 'INVALID_DEFINITION', issues))).toMatchObject({ kind: 'invalid', issues });
  });

  it('knows NO_QUESTIONS', () => {
    expect(classifyPublishError(apiError(422, 'NO_QUESTIONS')).kind).toBe('no_questions');
    expect(classifyPublishError(apiError(500)).kind).toBe('other');
  });
});
