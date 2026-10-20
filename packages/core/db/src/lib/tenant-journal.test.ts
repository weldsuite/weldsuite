import { describe, expect, it } from 'vitest';
import {
  describeJournalGap,
  isAtJournalLevel,
  matchTenantJournal,
  RETIRED_MIGRATION_HASHES,
  SUPERSEDED_MIGRATION_HASHES,
  type RecordedMigration,
  type TenantJournalEntry,
} from './tenant-journal';

const journal: TenantJournalEntry[] = [
  { tag: '0000_first', when: 100, hash: 'h0' },
  { tag: '0001_second', when: 200, hash: 'h1' },
  { tag: '0002_third', when: 150, hash: 'h2' }, // merged with an older timestamp
  { tag: '0124_massive_natasha_romanoff', when: 300, hash: 'h124-now' },
];

const row = (over: Partial<RecordedMigration>): RecordedMigration => ({ tag: null, hash: null, createdAt: null, ...over });
const [retiredHash] = [...RETIRED_MIGRATION_HASHES.keys()];
const [supersededHash] = [...SUPERSEDED_MIGRATION_HASHES.keys()];

describe('matchTenantJournal', () => {
  it('recognises a row by tag, by hash, and by created_at when the file changed since', () => {
    const match = matchTenantJournal(
      [
        row({ tag: '0000_first', hash: 'anything' }), // the worker's applier
        row({ hash: 'h1', createdAt: '200' }), // drizzle's migrator
        row({ hash: 'edited-later', createdAt: '150' }), // drizzle, file edited after it ran
        row({ tag: '0124_massive_natasha_romanoff' }),
      ],
      journal,
    );
    expect([...match.applied].sort()).toEqual(['0000_first', '0001_second', '0002_third', '0124_massive_natasha_romanoff']);
    expect(isAtJournalLevel(match)).toBe(true);
    expect(match.duplicates).toBe(0);
  });

  it('reports the migration drizzle skipped because it was older than the newest row', () => {
    const match = matchTenantJournal(
      [row({ hash: 'h0', createdAt: '100' }), row({ hash: 'h1', createdAt: '200' }), row({ tag: '0124_massive_natasha_romanoff' })],
      journal,
    );
    expect(match.missing.map((entry) => entry.tag)).toEqual(['0002_third']);
    expect(isAtJournalLevel(match)).toBe(false);
    expect(describeJournalGap(match)).toBe('1 migration(s) missing (0002_third)');
  });

  it('ignores retired rows and counts a superseded version as its migration', () => {
    const match = matchTenantJournal(
      [
        row({ tag: '0000_first' }),
        row({ tag: '0001_second' }),
        row({ tag: '0002_third' }),
        row({ hash: retiredHash, createdAt: '1776340297800' }),
        row({ hash: supersededHash, createdAt: '1777662354345' }),
      ],
      journal,
    );
    expect(match.unknown).toEqual([]);
    expect(match.applied.has('0124_massive_natasha_romanoff')).toBe(true);
    expect(isAtJournalLevel(match)).toBe(true);
  });

  it('flags rows nothing explains, and counts repeats as harmless duplicates', () => {
    const match = matchTenantJournal(
      [
        row({ tag: '0000_first' }),
        row({ tag: '0000_first' }),
        row({ hash: 'h1', createdAt: '200' }),
        row({ tag: '0002_third' }),
        row({ tag: '0124_massive_natasha_romanoff' }),
        row({ tag: 'feature_branch_only', hash: 'zzz', createdAt: '999' }),
      ],
      journal,
    );
    expect(match.duplicates).toBe(1);
    expect(match.unknown).toHaveLength(1);
    expect(isAtJournalLevel(match)).toBe(false);
    expect(describeJournalGap(match)).toBe('1 row(s) of migrations the journal does not know');
  });

  it('does not let a tag the journal does not have stand in for a migration', () => {
    const match = matchTenantJournal([row({ tag: 'renamed_since', hash: 'h0', createdAt: '100' })], journal);
    expect(match.applied.has('0000_first')).toBe(true);
    expect(match.unknown).toEqual([]);
  });

  it('shortens a long gap', () => {
    const match = matchTenantJournal([], journal);
    expect(describeJournalGap(match, 2)).toBe('4 migration(s) missing (0000_first, 0001_second, +2 more)');
    expect(describeJournalGap(matchTenantJournal([row({ tag: '0000_first' })], [journal[0]!]))).toBe('at the journal level');
  });
});
