/**
 * Optimistic "important" toggle for the mail query cache.
 *
 * Cached mail comes in a few shapes (a message row, a thread's messages, and
 * pages of thread summaries for a folder). `patchCachedImportant` rewrites the
 * one message everywhere it shows up and leaves every other shape untouched, so
 * the star-like toggle in the reading pane is reflected in the list row at once.
 */

import { hasLabel, withLabel, withoutLabel } from './message-labels';

const IMPORTANT = 'IMPORTANT';

interface MessageLike {
  id: string;
  isImportant?: boolean;
  labels?: string[] | null;
}

interface ThreadLike {
  labels?: string[] | null;
  messages?: MessageLike[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function patchMessage(message: MessageLike, id: string, on: boolean): MessageLike {
  if (message.id !== id) return message;
  return {
    ...message,
    isImportant: on,
    labels: on ? withLabel(message.labels, IMPORTANT) : withoutLabel(message.labels, IMPORTANT),
  };
}

function patchThread(thread: ThreadLike, id: string, on: boolean): ThreadLike {
  const messages = thread.messages;
  if (!messages?.some((m) => m.id === id)) return thread;
  const patched = messages.map((m) => patchMessage(m, id, on));
  // The thread's label union keeps IMPORTANT while any of its messages has it.
  const stillImportant = patched.some((m) => m.isImportant || hasLabel(m.labels, IMPORTANT));
  const labels = stillImportant
    ? withLabel(thread.labels, IMPORTANT)
    : withoutLabel(thread.labels, IMPORTANT);
  return { ...thread, messages: patched, labels };
}

/** The cached value with message `id` marked (or unmarked) important; other shapes come back as they were. */
export function patchCachedImportant(data: unknown, id: string, on: boolean): unknown {
  if (!isRecord(data)) return data;

  // Infinite query: { pages: [...] }
  if (Array.isArray(data.pages)) {
    return { ...data, pages: data.pages.map((page: unknown) => patchCachedImportant(page, id, on)) };
  }

  const inner = data.data;
  if (!isRecord(inner)) return data;

  // Folder page: { data: { threads: [...] } }
  if (Array.isArray(inner.threads)) {
    const threads = inner.threads as ThreadLike[];
    return { ...data, data: { ...inner, threads: threads.map((th) => patchThread(th, id, on)) } };
  }
  // Thread detail: { data: { messages: [...] } }
  if (Array.isArray(inner.messages)) {
    const messages = inner.messages as MessageLike[];
    return { ...data, data: { ...inner, messages: messages.map((m) => patchMessage(m, id, on)) } };
  }
  // Message detail: { data: { id, ... } }
  if (inner.id === id) {
    return { ...data, data: patchMessage(inner as unknown as MessageLike, id, on) };
  }
  return data;
}
