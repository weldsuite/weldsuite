/**
 * The pure rules of the service catalogue: which conversations can become a
 * request, and how a request shows to its customer. The database parts run on
 * pglite in `@weldsuite/desk-domain` (catalog-pglite.test.ts) and through the
 * desk-api routes.
 */

import { describe, expect, it } from 'vitest';
import { assertDeskRequestStartable, DeskCatalogRefusedError } from './desk-catalog';
import { deskPortalApprovalState } from './desk-portal';

const open = { mergedIntoId: null, catalogItemId: null, state: 'open' } as const;

function refusal(conversation: Parameters<typeof assertDeskRequestStartable>[0]): string | null {
  try {
    assertDeskRequestStartable(conversation);
    return null;
  } catch (err) {
    if (err instanceof DeskCatalogRefusedError) return err.reason;
    throw err;
  }
}

describe('assertDeskRequestStartable', () => {
  it('lets an open, unmerged conversation without an item start', () => {
    expect(refusal(open)).toBeNull();
  });

  it.each([
    [{ ...open, mergedIntoId: 'dconv_kept' }, 'merged'],
    [{ ...open, catalogItemId: 'dcat_1' }, 'already_request'],
    [{ ...open, state: 'closed' }, 'closed'],
    // A merged duplicate is closed too: the merge is the reason that counts.
    [{ mergedIntoId: 'dconv_kept', catalogItemId: null, state: 'closed' }, 'merged'],
  ] as const)('refuses %o with %s', (conversation, reason) => {
    expect(refusal(conversation)).toBe(reason);
  });
});

describe('deskPortalApprovalState', () => {
  it.each([
    ['pending', 'awaiting_approval'],
    ['approved', 'approved'],
    ['rejected', 'rejected'],
    [null, null],
  ] as const)('%s shows as %s', (approvalStatus, state) => {
    expect(deskPortalApprovalState({ approvalStatus })).toBe(state);
  });
});
