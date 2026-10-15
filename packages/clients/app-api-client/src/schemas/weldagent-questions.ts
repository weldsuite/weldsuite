/**
 * WeldAgent questions — the `ask_user` tool an agent calls to ask the user a
 * multiple-choice question. Shared by the agent runtime (tool definition,
 * stream marker) and the platform (question cards).
 *
 * Conversation turns store the question as the tool invocation's `args`.
 * Streamed turns (the WeldAgent drawer) carry it inline in the text stream,
 * between two record-separator characters, so the client can lift it out.
 */

import { z } from 'zod';

export const ASK_USER_TOOL_NAME = 'ask_user';

export const agentQuestionOptionSchema = z.object({
  label: z.string().min(1).max(80).describe('Short answer the user can pick, e.g. "Every morning at 8".'),
  description: z.string().max(160).optional().describe('Optional one-line detail shown under the label.'),
});

export const agentQuestionSchema = z.object({
  question: z.string().min(3).max(300).describe('One focused question, phrased the way you would say it.'),
  options: z
    .array(agentQuestionOptionSchema)
    .min(2)
    .max(4)
    .describe('2 to 4 likely answers. The user can always type their own answer instead.'),
  multiSelect: z
    .boolean()
    .optional()
    .describe('True when the user may pick more than one option.'),
});

export type AgentQuestionOption = z.infer<typeof agentQuestionOptionSchema>;
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;

/** Validate tool-call args (or stream payloads) into a question, or null. */
export function parseAgentQuestion(value: unknown): AgentQuestion | null {
  const parsed = agentQuestionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const MARKER = '\u001e';
const MARKER_PREFIX = `${MARKER}ask:`;

/** Inline form of a question in a streamed reply. */
export function encodeQuestionMarker(question: AgentQuestion): string {
  return `${MARKER_PREFIX}${JSON.stringify(question)}${MARKER}`;
}

/**
 * Split a streamed reply into its text and the questions it carries. A marker
 * still being streamed (no closing separator yet) is dropped from the text
 * rather than shown half-written.
 */
export function splitQuestionMarkers(raw: string): { text: string; questions: AgentQuestion[] } {
  const questions: AgentQuestion[] = [];
  let text = '';
  let rest = raw;
  for (;;) {
    const start = rest.indexOf(MARKER_PREFIX);
    if (start < 0) {
      text += rest;
      break;
    }
    text += rest.slice(0, start);
    const end = rest.indexOf(MARKER, start + MARKER_PREFIX.length);
    if (end < 0) break;
    try {
      const question = parseAgentQuestion(JSON.parse(rest.slice(start + MARKER_PREFIX.length, end)));
      if (question) questions.push(question);
    } catch {
      // A malformed marker is dropped.
    }
    rest = rest.slice(end + MARKER.length);
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), questions };
}

/**
 * A streamed reply as plain history for the next turn: each question becomes
 * a line the model can read back ("[Asked: … Options: a / b]").
 */
export function questionMarkersToText(raw: string): string {
  const { text, questions } = splitQuestionMarkers(raw);
  const asked = questions.map(
    (q) => `[Asked the user: ${q.question} Options: ${q.options.map((o) => o.label).join(' / ')}]`,
  );
  return [text, ...asked].filter(Boolean).join('\n\n');
}

/** The message sent back when the user picks options on a question card. */
export function answerFromOptions(labels: string[]): string {
  return labels.join(', ');
}
