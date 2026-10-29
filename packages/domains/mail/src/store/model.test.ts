/**
 * Unit tests for the pure mailbox model: label/move semantics (ported cases
 * from `../labels-locations.test.ts` and `../labels-archive.test.ts`, which
 * exercise the same rules through SQL), legacy normalisation, folder
 * membership, and mail rule evaluation/actions.
 */
import { describe, expect, it } from 'vitest';
import {
  addLabels,
  applyRuleAction,
  applyRuleActions,
  evalRuleCondition,
  flagsForLabelChange,
  folderKeys,
  inboundRuleMatches,
  isInTrashOrSpam,
  labelsForFlagPatch,
  leaveLocation,
  normalizeLabel,
  normalizeLegacy,
  removeLabels,
  type RuleMessageState,
  SYSTEM_LABELS,
} from './model';

describe('addLabels', () => {
  it('normalises system slugs and never duplicates', () => {
    expect(addLabels(['INBOX'], 'starred', 'STARRED', 'Invoices', 'Invoices')).toEqual([
      'INBOX',
      'STARRED',
      'Invoices',
    ]);
  });

  it('replaces the previous location when a location label is added', () => {
    expect(addLabels(['INBOX', 'Invoices'], 'TRASH')).toEqual(['Invoices', 'TRASH']);
    expect(addLabels(['TRASH', 'INBOX', 'INBOX'], 'inbox')).toEqual(['INBOX']);
  });

  it('clears PROMOTIONS and SNOOZED on a move, not just the other locations', () => {
    expect(addLabels(['PROMOTIONS', 'SNOOZED'], 'ARCHIVE')).toEqual(['ARCHIVE']);
  });
});

describe('removeLabels', () => {
  it('normalises the slug it removes', () => {
    expect(removeLabels(['INBOX', 'STARRED'], 'starred')).toEqual(['INBOX']);
  });

  it('is a no-op when the label is absent', () => {
    expect(removeLabels(['INBOX'], 'TRASH')).toEqual(['INBOX']);
  });
});

describe('flagsForLabelChange', () => {
  it('sets isStarred / isImportant for their system labels', () => {
    expect(flagsForLabelChange(['STARRED'], 'add')).toEqual({ isStarred: true });
    expect(flagsForLabelChange(['STARRED'], 'remove')).toEqual({ isStarred: false });
    expect(flagsForLabelChange(['IMPORTANT'], 'add')).toEqual({ isImportant: true });
  });

  it('sets isTrash/isSpam together when adding a location label', () => {
    expect(flagsForLabelChange(['TRASH'], 'add')).toEqual({ isTrash: true, isSpam: false });
    expect(flagsForLabelChange(['SPAM'], 'add')).toEqual({ isTrash: false, isSpam: true });
  });

  it('clears the matching flag when removing TRASH/SPAM directly', () => {
    expect(flagsForLabelChange(['TRASH'], 'remove')).toEqual({ isTrash: false });
    expect(flagsForLabelChange(['SPAM'], 'remove')).toEqual({ isSpam: false });
  });
});

// ---------------------------------------------------------------------------
// Ported from labels-locations.test.ts (TASK-897 / TASK-898): the pglite
// suite proves the SQL-backed write paths produce this result; these prove
// the pure helpers those paths call compute it.
// ---------------------------------------------------------------------------

describe('leaveLocation / labelsForFlagPatch (TASK-897, TASK-898)', () => {
  it('deleting a message takes it out of the inbox and sets isTrash', () => {
    const result = labelsForFlagPatch(['INBOX'], { isTrash: true });
    expect(result).toEqual({ labels: ['TRASH'], isTrash: true, isSpam: false });
  });

  it('marking spam takes it out of the inbox and sets isSpam, keeping other labels', () => {
    const result = labelsForFlagPatch(['INBOX', 'Invoices'], { isSpam: true });
    expect(result).toEqual({ labels: ['Invoices', 'SPAM'], isTrash: false, isSpam: true });
  });

  it('restore (isTrash: false) returns to the inbox when nowhere else applies', () => {
    const result = labelsForFlagPatch(['TRASH'], { isTrash: false });
    expect(result).toEqual({ labels: ['INBOX'], isTrash: false, isSpam: false });
  });

  it('leaveLocation only checks TRASH/SPAM/ARCHIVE for "elsewhere" — unlike the bulk/thread move path (`moveMessagesToLocation`), it does not special-case SENT/DRAFT, so untrashing a sent mail here still adds INBOX back alongside SENT', () => {
    // This mirrors `updateMessage({ isTrash: false })` on a single message exactly
    // as it behaves today; `bulkUpdateMessages(..., 'restore')` goes through the
    // separate SQL path in `moveMessagesToLocation`, which does special-case
    // OUTGOING_LABELS (see labels-locations.test.ts "restore puts a sent mail
    // back in Sent, not the inbox").
    expect(leaveLocation(['SENT', 'TRASH'], 'TRASH')).toEqual(['SENT', 'INBOX']);
  });

  it('untrashing mail that is also archived stays in the archive', () => {
    expect(leaveLocation(['ARCHIVE', 'TRASH'], 'TRASH')).toEqual(['ARCHIVE']);
  });

  it('the toolbar star patch writes the STARRED label alongside isStarred', () => {
    expect(labelsForFlagPatch(['INBOX'], { isStarred: true })).toEqual({ labels: ['INBOX', 'STARRED'] });
    expect(labelsForFlagPatch(['INBOX', 'STARRED'], { isStarred: false })).toEqual({ labels: ['INBOX'] });
  });

  it('moving to trash through the isTrash flag is a move too, and reversible', () => {
    const trashed = labelsForFlagPatch(['INBOX', 'STARRED'], { isTrash: true });
    expect(trashed).toEqual({ labels: ['STARRED', 'TRASH'], isTrash: true, isSpam: false });

    const restored = labelsForFlagPatch(trashed!.labels, { isTrash: false });
    expect(restored).toEqual({ labels: ['STARRED', 'INBOX'], isTrash: false, isSpam: false });
  });

  it('returns null when the patch touches none of the mirrored flags', () => {
    expect(labelsForFlagPatch(['INBOX'], {})).toBeNull();
  });
});

describe('normalizeLabel', () => {
  it('upper-cases a system slug and leaves a user label as typed', () => {
    expect(normalizeLabel('inbox')).toBe('INBOX');
    expect(normalizeLabel('Invoices')).toBe('Invoices');
  });
});

// ---------------------------------------------------------------------------
// normalizeLegacy
// ---------------------------------------------------------------------------

describe('normalizeLegacy', () => {
  it('folds the boolean flags into labels', () => {
    expect(
      normalizeLegacy({ labels: ['INBOX'], isStarred: true, isImportant: true, isTrash: false, isSpam: false }),
    ).toEqual(expect.arrayContaining(['INBOX', 'STARRED', 'IMPORTANT']));
  });

  it('is idempotent and never duplicates an already-present label', () => {
    expect(normalizeLegacy({ labels: ['INBOX', 'STARRED'], isStarred: true })).toEqual(['INBOX', 'STARRED']);
  });

  it('keeps just one location label by precedence TRASH > SPAM > ARCHIVE > INBOX', () => {
    expect(normalizeLegacy({ labels: ['INBOX', 'ARCHIVE'], isTrash: true, isSpam: true })).toEqual(['TRASH']);
    expect(normalizeLegacy({ labels: ['ARCHIVE', 'INBOX'] })).toEqual(['ARCHIVE']);
  });

  it('leaves a message with no location labels alone', () => {
    expect(normalizeLegacy({ labels: ['SENT'] })).toEqual(['SENT']);
  });
});

// ---------------------------------------------------------------------------
// folderKeys
// ---------------------------------------------------------------------------

describe('isInTrashOrSpam', () => {
  it('is true by label or by the mirrored flag', () => {
    expect(isInTrashOrSpam({ labels: ['TRASH'] })).toBe(true);
    expect(isInTrashOrSpam({ labels: [], isSpam: true })).toBe(true);
    expect(isInTrashOrSpam({ labels: ['INBOX'] })).toBe(false);
  });
});

describe('folderKeys', () => {
  it('a deleted message belongs to no folder', () => {
    expect(folderKeys({ deletedAt: new Date(), labels: ['INBOX'] })).toEqual([]);
  });

  it('a live inbox message belongs to __total, __all and inbox', () => {
    expect(folderKeys({ labels: ['INBOX'] }).sort()).toEqual(['__all', '__total', 'inbox'].sort());
  });

  it('a live message with a user label gets both the system and the user folder', () => {
    expect(folderKeys({ labels: ['INBOX', 'Invoices'] }).sort()).toEqual(
      ['__all', '__total', 'inbox', 'invoices'].sort(),
    );
  });

  it('trash and spam never get __all, and show only in their own folder', () => {
    expect(folderKeys({ labels: ['TRASH'] }).sort()).toEqual(['__total', 'trash'].sort());
    expect(folderKeys({ labels: ['SPAM'] }).sort()).toEqual(['__total', 'spam'].sort());
  });

  it('a flag with no matching label adds no folder key: the per-label loop decides trash/spam membership, not the flag (the object always keeps labels and flags in step)', () => {
    expect(folderKeys({ labels: [], isSpam: true })).toEqual(['__total']);
  });

  it('an archived user label is hidden from its own folder but still counts __all/archive', () => {
    expect(folderKeys({ labels: ['ARCHIVE', 'Invoices'] }).sort()).toEqual(['__all', '__total', 'archive'].sort());
  });

  it('a user label folder is not hidden when the message is merely in the inbox', () => {
    expect(folderKeys({ labels: ['INBOX', 'Invoices'] })).toContain('invoices');
  });

  it('__scheduled applies only for a live scheduled send carrying the label', () => {
    expect(
      folderKeys({ labels: ['SCHEDULED'], sendStatus: 'scheduled' }),
    ).toContain('__scheduled');
    expect(folderKeys({ labels: ['SCHEDULED'], sendStatus: 'sent' })).not.toContain('__scheduled');
    expect(
      folderKeys({ labels: ['SCHEDULED', 'TRASH'], sendStatus: 'scheduled' }),
    ).not.toContain('__scheduled');
  });
});

// ---------------------------------------------------------------------------
// Mail rule evaluation
// ---------------------------------------------------------------------------

describe('evalRuleCondition', () => {
  it('matches "contains" case-insensitively on the from address', () => {
    expect(
      evalRuleCondition(
        { from: { email: 'Newsletter@Example.com' } },
        { field: 'from', operator: 'contains', value: 'example' },
      ),
    ).toBe(true);
  });

  it('matches "equals" on subject case-insensitively', () => {
    expect(
      evalRuleCondition({ subject: 'Invoice Due' }, { field: 'subject', operator: 'equals', value: 'invoice due' }),
    ).toBe(true);
    expect(
      evalRuleCondition({ subject: 'Invoice Due' }, { field: 'subject', operator: 'equals', value: 'other' }),
    ).toBe(false);
  });

  it('compares size numerically', () => {
    expect(evalRuleCondition({ sizeBytes: 5000 }, { field: 'size', operator: 'greater_than', value: '1000' })).toBe(
      true,
    );
    expect(evalRuleCondition({ sizeBytes: 500 }, { field: 'size', operator: 'greater_than', value: '1000' })).toBe(
      false,
    );
  });

  it('reads has_attachment as a boolean field', () => {
    expect(
      evalRuleCondition({ hasAttachments: true }, { field: 'has_attachment', operator: 'is_true', value: '' }),
    ).toBe(true);
  });

  it('unknown field or operator never matches', () => {
    expect(evalRuleCondition({}, { field: 'nope', operator: 'contains', value: 'x' })).toBe(false);
    expect(evalRuleCondition({ subject: 'x' }, { field: 'subject', operator: 'nope', value: 'x' })).toBe(false);
  });
});

describe('inboundRuleMatches', () => {
  it('never matches an outgoing-scoped rule for inbound mail', () => {
    expect(
      inboundRuleMatches(
        { scope: 'outgoing', conditions: [{ field: 'subject', operator: 'contains', value: 'x' }] },
        { subject: 'x' },
      ),
    ).toBe(false);
  });

  it('respects a folder restriction', () => {
    const rule = { folders: ['INBOX'], conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }] };
    expect(inboundRuleMatches(rule, { subject: 'Invoice #1', labels: ['INBOX'] })).toBe(true);
    expect(inboundRuleMatches(rule, { subject: 'Invoice #1', labels: ['SPAM'] })).toBe(false);
  });

  it('matchType "all" requires every condition; "any" requires one', () => {
    const conditions = [
      { field: 'subject', operator: 'contains', value: 'invoice' },
      { field: 'from', operator: 'contains', value: 'billing' },
    ];
    expect(
      inboundRuleMatches(
        { conditions, matchType: 'all' },
        { subject: 'Invoice', from: { email: 'billing@example.com' } },
      ),
    ).toBe(true);
    expect(
      inboundRuleMatches({ conditions, matchType: 'all' }, { subject: 'Invoice', from: { email: 'x@y.com' } }),
    ).toBe(false);
    expect(
      inboundRuleMatches({ conditions, matchType: 'any' }, { subject: 'Invoice', from: { email: 'x@y.com' } }),
    ).toBe(true);
  });

  it('a rule with no conditions never matches', () => {
    expect(inboundRuleMatches({ conditions: [] }, { subject: 'x' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule actions
// ---------------------------------------------------------------------------

function freshState(labels: string[] = ['INBOX']): RuleMessageState {
  return { labels, isRead: false, isFlagged: false, isSpam: false, deleted: false };
}

describe('applyRuleAction', () => {
  it('mark_as_spam moves to Spam and sets isSpam, displacing INBOX/ARCHIVE/PROMOTIONS', () => {
    const result = applyRuleAction(freshState(['INBOX', 'PROMOTIONS']), { type: 'mark_as_spam' });
    expect(result.applied).toBe(true);
    expect(result.state.labels.sort()).toEqual(['SPAM']);
    expect(result.state.isSpam).toBe(true);
  });

  it('simple actions set their field without touching labels', () => {
    expect(applyRuleAction(freshState(), { type: 'delete' })).toEqual({
      state: { ...freshState(), deleted: true },
      applied: true,
    });
    expect(applyRuleAction(freshState(), { type: 'flag' }).state.isFlagged).toBe(true);
    expect(applyRuleAction(freshState(), { type: 'mark_as_read' }).state.isRead).toBe(true);
  });

  it('star adds STARRED once', () => {
    const once = applyRuleAction(freshState(), { type: 'star' });
    expect(once.state.labels).toContain('STARRED');
    const twice = applyRuleAction(once.state, { type: 'star' });
    expect(twice.applied).toBe(true);
    expect(twice.state.labels.filter((l) => l === 'STARRED')).toHaveLength(1);
  });

  it('archive drops INBOX and adds ARCHIVE', () => {
    const result = applyRuleAction(freshState(['INBOX']), { type: 'archive' });
    expect(result.state.labels).toEqual(['ARCHIVE']);
  });

  it('move_to_folder / add_label / remove_label need a labelId, and do not apply without one', () => {
    expect(applyRuleAction(freshState(), { type: 'move_to_folder' }).applied).toBe(false);
    expect(applyRuleAction(freshState(), { type: 'add_label' }).applied).toBe(false);
    const added = applyRuleAction(freshState(['INBOX']), { type: 'add_label', labelId: 'Receipts' });
    expect(added.state.labels).toEqual(['INBOX', 'Receipts']);
    const removed = applyRuleAction(added.state, { type: 'remove_label', labelId: 'Receipts' });
    expect(removed.state.labels).toEqual(['INBOX']);
  });

  it('an unknown action type does not apply and leaves state untouched', () => {
    const state = freshState();
    const result = applyRuleAction(state, { type: 'does_not_exist' });
    expect(result.applied).toBe(false);
    expect(result.state).toBe(state);
  });
});

describe('applyRuleActions', () => {
  it('counts only the actions that applied, and reports mark_as_spam', () => {
    const result = applyRuleActions(freshState(['INBOX']), [
      { type: 'flag' },
      { type: 'add_label' }, // no labelId: does not apply
      { type: 'mark_as_spam' },
    ]);
    expect(result.actionsApplied).toBe(2);
    expect(result.markedSpam).toBe(true);
    expect(result.state.isFlagged).toBe(true);
    expect(result.state.labels).toEqual(['SPAM']);
  });

  it('applies actions in order, each seeing the previous result', () => {
    const result = applyRuleActions(freshState(['INBOX']), [
      { type: 'add_label', labelId: 'A' },
      { type: 'remove_label', labelId: 'A' },
    ]);
    expect(result.state.labels).toEqual(['INBOX']);
    expect(result.actionsApplied).toBe(2);
  });
});

// Re-exported constant sanity: the system label vocabulary model.ts owns.
describe('SYSTEM_LABELS', () => {
  it('covers the location labels used throughout this file', () => {
    expect(SYSTEM_LABELS.INBOX).toBe('INBOX');
    expect(SYSTEM_LABELS.TRASH).toBe('TRASH');
    expect(SYSTEM_LABELS.SPAM).toBe('SPAM');
    expect(SYSTEM_LABELS.ARCHIVE).toBe('ARCHIVE');
  });
});
