/**
 * What a commenter may change: someone who can view a board and holds
 * `boards:comment`, but cannot edit it (docs/plans/weldboard.md, Access).
 *
 * What is said in a comment thread lives in the board's WeldChat chat (ADR
 * CHAT-007); the board holds each thread's pin (where it is, who started
 * it, whether it is resolved). The room checks a commenter's ops as they
 * would be applied, against the board before them. A batch passes only if
 * every op in it does:
 *
 *   - `create` of comment pins they start (createdBy is them);
 *   - `set` on their own pins (move them), or only `resolved` on anyone's;
 *   - `delete` of their own pins.
 *
 * Anything else is refused like a viewer's edit.
 */

import { unbatch, type Board, type BoardElement, type Op } from '@weldsuite/board-engine';

export function isCommentersOp(op: Op, userId: string, board: Board): boolean {
  const created = new Map<string, BoardElement>();
  const own = (id: string) => {
    const el = created.get(id) ?? board.get(id);
    return !el || (el.type === 'comment' && el.createdBy === userId);
  };
  return unbatch(op).every((o) => {
    switch (o.type) {
      case 'create':
        return o.elements.every((el) => {
          if (el.type !== 'comment' || el.createdBy !== userId) return false;
          created.set(el.id, el);
          return true;
        });
      case 'set': {
        const el = created.get(o.id) ?? board.get(o.id);
        if (!el) return true; // gone: the op does nothing
        if (el.type !== 'comment') return false;
        const keys = Object.keys(o.patch);
        if (keys.every((k) => k === 'resolved')) return true;
        return own(o.id) && keys.every((k) => k === 'x' || k === 'y' || k === 'resolved' || k === 'target');
      }
      case 'delete':
        return o.ids.every(own);
      default:
        return false;
    }
  });
}
