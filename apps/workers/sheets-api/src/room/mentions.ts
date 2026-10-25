/**
 * Who a committed comment newly mentions, so the room can notify them once.
 *
 * Comments live in the workbook and change only through `patchComments`, so
 * the room keeps, per comment, the people it already mentions: a new comment
 * notifies everyone it names, an edit only the people it adds. Built from the
 * workbook when the room loads (or a version is restored), so mentions made
 * before never notify again.
 */

import type { Engine, Op, SheetComment } from '@weldsuite/sheets-engine';

export interface NewMention {
  comment: SheetComment;
  /** The workbook tab the thread is on. */
  tabId: string;
  /** People to notify (never the author). */
  userIds: string[];
}

export class MentionTracker {
  private readonly seen = new Map<string, Set<string>>();

  constructor(engine: Engine) {
    this.reset(engine);
  }

  reset(engine: Engine): void {
    this.seen.clear();
    for (const sheet of engine.workbook.sheets) {
      for (const c of sheet.comments) this.seen.set(key(sheet.id, c.id), new Set(c.mentions ?? []));
    }
  }

  /** The mentions `op` adds, now remembered. */
  take(op: Op): NewMention[] {
    const out: NewMention[] = [];
    for (const o of op.type === 'batch' ? op.ops : [op]) {
      if (o.type === 'deleteSheet') this.forgetTab(o.sheetId);
      if (o.type !== 'patchComments') continue;
      for (const id of o.remove ?? []) this.seen.delete(key(o.sheetId, id));
      for (const c of o.set ?? []) {
        const before = this.seen.get(key(o.sheetId, c.id)) ?? new Set<string>();
        const now = new Set(c.mentions ?? []);
        this.seen.set(key(o.sheetId, c.id), now);
        const added = [...now].filter((u) => !before.has(u) && u !== c.author.id);
        if (added.length) out.push({ comment: c, tabId: o.sheetId, userIds: added });
      }
    }
    return out;
  }

  private forgetTab(tabId: string): void {
    for (const k of [...this.seen.keys()]) if (k.startsWith(`${tabId}:`)) this.seen.delete(k);
  }
}

const key = (tabId: string, commentId: string) => `${tabId}:${commentId}`;

/** A comment's text for a notification: mentions as plain names, cut short. */
export function plainBody(body: string, max = 200): string {
  const text = body.replace(/@\[([^\]]*)\]\([^)]*\)/g, '@$1').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
