/**
 * The warmup corpus: natural English business email threads the network sends
 * between pool mailboxes. Plain text, no links, no tracking, no marker that
 * says "warmup". Names are filled in per pair.
 *
 * CONTRACT (the planner and sender code against these; keep them stable).
 */

/** One message of a thread; `author` says which side of the pair writes it. */
export interface CorpusMessage {
  author: 'starter' | 'responder';
  /** Plain text with placeholders: {{senderFirstName}}, {{senderLastName}}, {{recipientFirstName}}, {{recipientLastName}}. */
  body: string;
}

export interface CorpusThread {
  /** Stable id, e.g. "builtin-017" or "gen-2026-10-042". */
  id: string;
  /** Subject of the first message; replies use "Re: <subject>". */
  subject: string;
  /** 2–4 messages, alternating starter / responder. */
  messages: CorpusMessage[];
}

export interface CorpusPerson {
  firstName: string;
  lastName: string;
}

export interface RenderedCorpusMessage {
  subject: string;
  text: string;
}
