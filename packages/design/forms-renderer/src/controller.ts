/**
 * The state shared by both layouts: the answers, the path the engine computes
 * from them, errors, timings, uploads in flight and the submit round trip.
 * Layout components only decide how the steps look and move.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  blockFields,
  computePath,
  displayAnswer,
  evaluateSubmission,
  fieldsOf,
  recall,
  validateAnswer,
  type AnswerError,
  type AnswerValue,
  type Answers,
  type Block,
  type FieldBlock,
  type FormDefinition,
  type PathResult,
} from '@weldsuite/forms-engine';
import type { FormRendererProps, FormTimings, SubmitResult } from './types';

export interface Numbering {
  /** Question number by field id, in path order (group children included). */
  byField: Map<string, number>;
  total: number;
}

function numberFields(def: FormDefinition, path: string[]): Numbering {
  const byField = new Map<string, number>();
  let n = 0;
  for (const id of path) {
    const block = def.blocks.find((b) => b.id === id);
    if (!block) continue;
    for (const field of blockFields(block)) {
      n += 1;
      byField.set(field.id, n);
    }
  }
  return { byField, total: n };
}

export interface EndingState {
  result: SubmitResult;
  /** Answers as submitted, for the quiz review. */
  answers: Answers;
}

export interface FormCore {
  answers: Answers;
  answersRef: { current: Answers };
  hidden: Record<string, string>;
  path: PathResult;
  numbering: Numbering;
  errors: Record<string, AnswerError>;
  setAnswer: (fieldId: string, value: AnswerValue | undefined) => void;
  /** Validates fields; stores the errors; returns the first wrong field id or null. */
  validate: (fields: FieldBlock[]) => string | null;
  setErrors: (errors: Record<string, AnswerError>) => void;
  rc: (text: string) => string;
  trackUpload: (promise: Promise<unknown>) => void;
  waitForUploads: () => Promise<void>;
  /** Uploads still running. */
  uploadsPending: () => boolean;
  /** Time on `blockId` since it was entered; call when leaving it. */
  leave: (blockId: string | null) => void;
  enter: (blockId: string) => void;
  takeTimings: () => FormTimings;
  /** Progress report for a step that was reached. */
  reportProgress: (lastBlockId: string) => void;
  submitting: boolean;
  submitFailed: boolean;
  ending: EndingState | null;
  /** Runs the submit (or its local preview); resolves to the first wrong field id when the server refused answers. */
  submit: () => Promise<string | null>;
  preview: boolean;
}

function onPathAnswers(def: FormDefinition, answers: Answers, path: string[]): Answers {
  const visible = new Set<string>();
  for (const id of path) {
    const block = def.blocks.find((b) => b.id === id);
    if (block) for (const f of blockFields(block)) visible.add(f.id);
  }
  const out: Answers = {};
  for (const [id, value] of Object.entries(answers)) if (visible.has(id)) out[id] = value;
  return out;
}

/** The ending the form would show, worked out in the browser (preview, and a live form without a submit handler). */
export function localEnding(def: FormDefinition, answers: Answers, hidden: Record<string, string>): SubmitResult {
  const evaluated = evaluateSubmission(def, { answers, hidden });
  const ending = def.endings.find((e) => e.id === evaluated.endingId) ?? def.endings[0];
  const ctx = { answers: evaluated.answers, hidden, variables: evaluated.variables };
  const text = (s: string) => recall(s, def, ctx);
  if (!ending) throw new Error('A definition needs at least one ending');
  return {
    ending: {
      id: ending.id,
      title: text(ending.title),
      description: ending.description ? text(ending.description) : null,
      redirectUrl: ending.redirectUrl ? recall(ending.redirectUrl, def, ctx, { encode: true }) : null,
      button: ending.button ? { text: ending.button.text, url: text(ending.button.url) } : null,
      showScore: ending.showScore,
      showAnswers: ending.showAnswers,
    },
    score: evaluated.score,
    quiz: ending.showAnswers ? evaluated.quiz : null,
  };
}

export function useFormCore(props: FormRendererProps): FormCore {
  const { definition: def, onProgress, onSubmit } = props;
  const hidden = useMemo(() => props.hidden ?? {}, [props.hidden]);
  const preview = props.mode === 'preview' || !onSubmit;
  const [answers, setAnswers] = useState<Answers>(() => ({ ...(props.initialAnswers ?? {}) }));
  const answersRef = useRef(answers);
  const [errors, setErrorsState] = useState<Record<string, AnswerError>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [ending, setEnding] = useState<EndingState | null>(null);
  const uploads = useRef(new Set<Promise<unknown>>());
  const timings = useRef<FormTimings>({});
  const entered = useRef<{ id: string; at: number } | null>(null);

  const path = useMemo(() => computePath(def, { answers, hidden }), [def, answers, hidden]);
  const numbering = useMemo(() => numberFields(def, path.path), [def, path.path]);

  const setAnswer = useCallback((fieldId: string, value: AnswerValue | undefined) => {
    const next = { ...answersRef.current };
    if (value === undefined) delete next[fieldId];
    else next[fieldId] = value;
    answersRef.current = next;
    setAnswers(next);
    setErrorsState((prev) => {
      if (!(fieldId in prev)) return prev;
      const rest = { ...prev };
      delete rest[fieldId];
      return rest;
    });
  }, []);

  const validate = useCallback((fields: FieldBlock[]): string | null => {
    const found: Record<string, AnswerError> = {};
    let first: string | null = null;
    for (const field of fields) {
      const error = validateAnswer(field, answersRef.current[field.id]);
      if (error) {
        found[field.id] = error;
        first ??= field.id;
      }
    }
    setErrorsState((prev) => {
      const next = { ...prev };
      for (const field of fields) delete next[field.id];
      return { ...next, ...found };
    });
    return first;
  }, []);

  const rc = useCallback(
    (text: string) => (text.includes('{{') ? recall(text, def, { answers, hidden, variables: path.variables }) : text),
    [def, answers, hidden, path.variables],
  );

  const trackUpload = useCallback((promise: Promise<unknown>) => {
    const settled = promise.finally(() => uploads.current.delete(settled));
    uploads.current.add(settled);
  }, []);
  const waitForUploads = useCallback(async () => {
    while (uploads.current.size > 0) await Promise.allSettled([...uploads.current]);
  }, []);

  const uploadsPending = useCallback(() => uploads.current.size > 0, []);

  const leave = useCallback((blockId: string | null) => {
    const at = entered.current;
    if (at && (blockId === null || at.id === blockId)) {
      timings.current[at.id] = (timings.current[at.id] ?? 0) + Math.max(0, Date.now() - at.at);
      entered.current = null;
    }
  }, []);
  const enter = useCallback((blockId: string) => {
    entered.current = { id: blockId, at: Date.now() };
  }, []);
  const takeTimings = useCallback((): FormTimings => {
    const out = { ...timings.current };
    timings.current = {};
    return out;
  }, []);

  const reportProgress = useCallback(
    (lastBlockId: string) => {
      if (!onProgress || preview) return;
      onProgress({ lastBlockId, answers: answersRef.current, timings: takeTimings() });
    },
    [onProgress, preview, takeTimings],
  );

  const submit = useCallback(async (): Promise<string | null> => {
    if (uploadsPending()) await waitForUploads();
    leave(null);
    const current = answersRef.current;
    const finalPath = computePath(def, { answers: current, hidden });
    const sent = onPathAnswers(def, current, finalPath.path);
    setSubmitFailed(false);

    if (preview || !onSubmit) {
      setEnding({ result: localEnding(def, current, hidden), answers: sent });
      return null;
    }
    setSubmitting(true);
    try {
      const result = await onSubmit({ answers: sent, timings: takeTimings() });
      if ('fieldErrors' in result) {
        setErrorsState(result.fieldErrors);
        const order = fieldsOf(def).map((f) => f.id);
        return order.find((id) => id in result.fieldErrors) ?? Object.keys(result.fieldErrors)[0] ?? null;
      }
      setEnding({ result, answers: sent });
      return null;
    } catch {
      setSubmitFailed(true);
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [def, hidden, onSubmit, preview, uploadsPending, waitForUploads, leave, takeTimings]);

  return {
    answers,
    answersRef,
    hidden,
    path,
    numbering,
    errors,
    setAnswer,
    validate,
    setErrors: setErrorsState,
    rc,
    trackUpload,
    waitForUploads,
    uploadsPending,
    leave,
    enter,
    takeTimings,
    reportProgress,
    submitting,
    submitFailed,
    ending,
    submit,
    preview,
  };
}

/** The top-level block holding a field (the field's own block, or its group). */
export function topBlockOfField(def: FormDefinition, fieldId: string): Block | undefined {
  return def.blocks.find((b) => b.id === fieldId || (b.type === 'group' && b.children.some((c) => c.id === fieldId)));
}

/** Text of a quiz item for the ending: the respondent's answer and the right one. */
export function quizTexts(
  def: FormDefinition,
  fieldId: string,
  answers: Answers,
): { field: FieldBlock; answer: string; correct: string } | null {
  const field = fieldsOf(def).find((f) => f.id === fieldId);
  if (!field) return null;
  const correct =
    field.type === 'multiple_choice' || field.type === 'dropdown' || field.type === 'picture_choice'
      ? field.properties.choices
          .filter((c) => c.correct === true)
          .map((c) => c.label)
          .join(', ')
      : '';
  return { field, answer: displayAnswer(field, answers[fieldId]), correct };
}
