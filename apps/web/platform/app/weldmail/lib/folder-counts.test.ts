import { describe, expect, it } from 'vitest';
import { folderCountsFromStats } from './folder-counts';

const EMPTY = {
  total: 0,
  unread: 0,
  inboxUnread: 0,
  starred: 0,
  importantUnread: 0,
  sentUnread: 0,
  archiveUnread: 0,
  trashUnread: 0,
  spam: 0,
  snoozed: 0,
  scheduled: 0,
  drafts: 0,
};

describe('folderCountsFromStats', () => {
  it('maps every counter the stats endpoint returns to its folder', () => {
    expect(
      folderCountsFromStats([
        {
          ...EMPTY,
          inboxUnread: 3,
          starred: 1,
          importantUnread: 2,
          sentUnread: 4,
          archiveUnread: 5,
          trashUnread: 6,
          spam: 7,
          snoozed: 1,
          scheduled: 1,
          drafts: 2,
        },
      ]),
    ).toEqual({
      inbox: 3,
      starred: 1,
      important: 2,
      sent: 4,
      archive: 5,
      trash: 6,
      spam: 7,
      snoozed: 1,
      scheduled: 1,
      drafts: 2,
    });
  });

  it('leaves folders at zero without a badge', () => {
    expect(folderCountsFromStats([EMPTY])).toEqual({});
  });

  it('sums the mailboxes of the unified inbox and skips ones still loading', () => {
    expect(
      folderCountsFromStats([{ ...EMPTY, inboxUnread: 2, drafts: 1 }, undefined, { ...EMPTY, inboxUnread: 1 }]),
    ).toEqual({ inbox: 3, drafts: 1 });
  });

  it('tolerates an older API that only knows the first four counters', () => {
    expect(folderCountsFromStats([{ total: 4, unread: 2, inboxUnread: 2, starred: 0 }])).toEqual({ inbox: 2 });
  });
});
