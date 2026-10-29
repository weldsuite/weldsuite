/**
 * Mail as the calendar tests read it, from the memory transport their
 * `workerTransport` mock hands out (`@weldsuite/emails/transports/memory`).
 * In conformance mode the harness puts the Rust backend's mail in the same
 * transport, so the assertions check Rust's.
 */

import type { MemoryTransport } from '@weldsuite/emails/transports/memory';

export interface SentMail {
  to: string[];
  subject: string;
  html: string;
  /** Attachments with their content as text (the .ics). */
  attachments: { filename: string; content: string }[];
}

export function readSent(transport: MemoryTransport | null): SentMail[] {
  return (transport?.sent ?? []).map((email) => ({
    to: email.to.map((m) => m.email),
    subject: email.subject,
    html: email.html,
    attachments: (email.attachments ?? []).map((a) => ({
      filename: a.filename,
      content: typeof a.content === 'string' ? a.content : new TextDecoder().decode(a.content),
    })),
  }));
}
