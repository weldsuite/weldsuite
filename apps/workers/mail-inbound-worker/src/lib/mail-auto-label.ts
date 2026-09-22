/**
 * Build Jev multi-label (noul-per-label) questions and map answers → label names.
 *
 * Pure helpers — no DB / network — so unit tests can cover thresholding without
 * mocking Workers AI.
 */

import type { JevAnswer, JevNoulQuestion, JevQuestion } from '@weldsuite/ai';

export interface AiLabelCandidate {
  id: string;
  name: string;
  aiDescription: string;
  /** Minimum confidence 0–100 (defaults to 70). */
  aiConfidence: number | null;
}

export interface MailAutoLabelState {
  subject: string;
  from: { name: string; email: string };
  to: Array<{ name?: string; email?: string }>;
  preview: string;
}

/** Cap body preview so high-volume inbound stays cheap. */
export const MAIL_AUTO_LABEL_PREVIEW_CHARS = 2000;

/**
 * One noul question per candidate label. Question keys are label ids (stable;
 * names can collide / change).
 */
export function buildMailAutoLabelQuestions(
  candidates: AiLabelCandidate[],
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const label of candidates) {
    const q: JevNoulQuestion = {
      type: 'noul',
      instructions: `Should this email receive the label "${label.name}"? ${label.aiDescription}`,
      criteria: {
        true: `The email clearly matches the "${label.name}" description`,
        false: `The email does not match the "${label.name}" description`,
      },
    };
    questions[label.id] = q;
  }
  return questions;
}

export function buildMailAutoLabelState(input: {
  subject?: string | null;
  from?: { name?: string | null; email?: string | null } | null;
  to?: Array<{ name?: string | null; email?: string | null }> | null;
  textBody?: string | null;
}): MailAutoLabelState {
  const preview = (input.textBody || '').slice(0, MAIL_AUTO_LABEL_PREVIEW_CHARS);
  return {
    subject: input.subject || '',
    from: {
      name: input.from?.name || '',
      email: input.from?.email || '',
    },
    to: (input.to || []).map((r) => ({
      name: r.name || undefined,
      email: r.email || undefined,
    })),
    preview,
  };
}

/**
 * Apply when noul >= (aiConfidence / 100). Non-noul answers are ignored.
 */
export function matchedLabelsFromJevAnswers(
  candidates: AiLabelCandidate[],
  answers: Record<string, JevAnswer>,
): string[] {
  const matched: string[] = [];
  for (const label of candidates) {
    const answer = answers[label.id];
    if (!answer || answer.type !== 'noul') continue;
    const threshold = (label.aiConfidence ?? 70) / 100;
    if (answer.noul >= threshold) {
      matched.push(label.name);
    }
  }
  return matched;
}
