import { describe, expect, it } from 'vitest';
import type { BoardElement } from '@weldsuite/board-engine';
import { activeFilterCount, commentMatches, DEFAULT_COMMENT_FILTERS, type CommentFilters, type CommentThreadText } from './comment-filters';

const pin = (over: Partial<BoardElement> = {}): BoardElement => ({ id: 'p1', type: 'comment', x: 0, y: 0, w: 0, h: 0, order: 'a0', createdBy: 'bob', ...over }) as BoardElement;
const message = (authorId: string, authorName: string, content: string, mentions: string[] | null = null) => ({ authorId, authorName, content, mentions });
const thread = (...messages: CommentThreadText['messages'][number][]): CommentThreadText => ({ label: 'Customer interviews', messages });
const filters = (over: Partial<CommentFilters> = {}): CommentFilters => ({ ...DEFAULT_COMMENT_FILTERS, ...over });

describe('comment filters', () => {
  it('shows open threads by default, resolved ones on request, and both under All', () => {
    const open = pin();
    const resolved = pin({ resolved: true });
    const t = thread(message('bob', 'Bob', 'Looks good'));
    expect(commentMatches(open, t, filters(), 'alice')).toBe(true);
    expect(commentMatches(resolved, t, filters(), 'alice')).toBe(false);
    expect(commentMatches(resolved, t, filters({ status: 'resolved' }), 'alice')).toBe(true);
    expect(commentMatches(open, t, filters({ status: 'resolved' }), 'alice')).toBe(false);
    expect(commentMatches(resolved, t, filters({ status: 'all' }), 'alice')).toBe(true);
  });

  it('narrows to threads that mention me, or that I started', () => {
    const mentioned = thread(message('bob', 'Bob', 'What do you think, <@alice:Alice>?', ['alice']));
    const notMentioned = thread(message('bob', 'Bob', 'Ask <@carol:Carol>', ['carol']));
    expect(commentMatches(pin(), mentioned, filters({ people: 'mentions' }), 'alice')).toBe(true);
    expect(commentMatches(pin(), notMentioned, filters({ people: 'mentions' }), 'alice')).toBe(false);
    expect(commentMatches(pin({ createdBy: 'alice' }), notMentioned, filters({ people: 'mine' }), 'alice')).toBe(true);
    expect(commentMatches(pin(), notMentioned, filters({ people: 'mine' }), 'alice')).toBe(false);
  });

  it('searches every word in the text, the authors, the names mentioned and what the pin is on', () => {
    const t = thread(message('bob', 'Bob Smith', 'Move this closer to <@carol:Carol>'));
    for (const query of ['closer', 'CLOSER carol', 'smith', 'interviews', '  move   bob ']) {
      expect(commentMatches(pin(), t, filters({ query }), 'alice')).toBe(true);
    }
    expect(commentMatches(pin(), t, filters({ query: 'closer dave' }), 'alice')).toBe(false);
    // The token's user id isn't text anyone sees.
    expect(commentMatches(pin(), thread(message('bob', 'Bob', '<@usr_42:Carol>')), filters({ query: 'usr_42' }), 'alice')).toBe(false);
  });

  it('counts the filter choices that differ from the default (the search is apart)', () => {
    expect(activeFilterCount(filters())).toBe(0);
    expect(activeFilterCount(filters({ query: 'x' }))).toBe(0);
    expect(activeFilterCount(filters({ status: 'all' }))).toBe(1);
    expect(activeFilterCount(filters({ status: 'resolved', people: 'mine' }))).toBe(2);
  });
});
