/**
 * `isWorkspaceStorageKey`: the guard a caller-supplied `storagePath` /
 * mail-body key always passes through before it's trusted. Covers the
 * existing `workspaces/<id>/` prefix (regression) and the new `mail/<id>/`
 * prefix added for message bodies and raw MIME in R2
 * (docs/plans/weldmail-mailbox-store-design.md decision 4).
 */

import { describe, it, expect } from 'vitest';
import { isWorkspaceStorageKey } from './attachments';

const ORG = 'org_abc';
const WS = 'ws_abc';
const OTHER_WS = 'ws_other';

describe('isWorkspaceStorageKey', () => {
  it('accepts a key under workspaces/<id>/ for any id in the list (regression)', () => {
    expect(isWorkspaceStorageKey(`workspaces/${ORG}/mail/attachments/m1/1_file.txt`, [ORG, WS])).toBe(true);
    expect(isWorkspaceStorageKey(`workspaces/${WS}/mail/attachments/m1/1_file.txt`, [ORG, WS])).toBe(true);
  });

  it('accepts a key under mail/<id>/ for the matching workspace', () => {
    expect(isWorkspaceStorageKey(`mail/${WS}/acct_1/msg_1/body.html`, [ORG, WS])).toBe(true);
    expect(isWorkspaceStorageKey(`mail/${WS}/acct_1/msg_1/raw.eml`, WS)).toBe(true);
  });

  it("rejects mail/<id>/ for a workspace that isn't in the list", () => {
    expect(isWorkspaceStorageKey(`mail/${OTHER_WS}/acct_1/msg_1/body.html`, [ORG, WS])).toBe(false);
    expect(isWorkspaceStorageKey(`mail/${OTHER_WS}/acct_1/msg_1/body.html`, WS)).toBe(false);
  });

  it('rejects path traversal under either prefix', () => {
    expect(isWorkspaceStorageKey(`mail/${WS}/../${OTHER_WS}/msg_1/body.html`, [ORG, WS])).toBe(false);
    expect(isWorkspaceStorageKey(`workspaces/${WS}/../${OTHER_WS}/x`, [ORG, WS])).toBe(false);
  });

  it('rejects a key under neither prefix', () => {
    expect(isWorkspaceStorageKey('personal/p1/x.txt', [ORG, WS])).toBe(false);
    expect(isWorkspaceStorageKey(`mailx/${WS}/acct_1/msg_1/body.html`, [ORG, WS])).toBe(false);
  });

  it('ignores empty/falsy ids instead of matching everything', () => {
    expect(isWorkspaceStorageKey(`mail/${WS}/acct_1/msg_1/body.html`, ['', WS])).toBe(true);
    expect(isWorkspaceStorageKey(`mail//acct_1/msg_1/body.html`, [''])).toBe(false);
  });
});
