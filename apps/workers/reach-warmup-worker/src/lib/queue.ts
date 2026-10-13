/** Queue message bodies come from our own dispatcher, but a consumer still checks what it is handed. */

import { z } from 'zod';

const body = z.object({ messageId: z.string().min(1).max(64) });

/** The warmup message id of a queue body, or null when the body is not one (a poison message). */
export function parseMessageId(raw: unknown): string | null {
  const parsed = body.safeParse(raw);
  return parsed.success ? parsed.data.messageId : null;
}

/** The ids of every valid body in a batch. */
export function messageIdsOf(bodies: readonly unknown[]): string[] {
  return bodies.flatMap((raw) => {
    const id = parseMessageId(raw);
    return id === null ? [] : [id];
  });
}
