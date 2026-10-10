import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { buildTagOptions, collectKnownTags } from './known-tags';

describe('collectKnownTags', () => {
  it('reads plain and infinite list caches, most used first', () => {
    const qc = new QueryClient();
    qc.setQueryData(['companies', 'list', {}], {
      data: [{ tags: ['vip', 'nl'] }, { tags: ['vip'] }, { tags: null }, {}],
    });
    qc.setQueryData(['companies', 'list', 'infinite', {}], {
      pages: [{ data: [{ tags: ['nl', 'partner'] }] }, { data: [{ tags: ['vip'] }] }],
    });
    // Another entity's cache must not leak in.
    qc.setQueryData(['people', 'list', {}], { data: [{ tags: ['champion'] }] });

    expect(collectKnownTags(qc, ['companies', 'list'])).toEqual(['vip', 'nl', 'partner']);
  });

  it('ignores blank and non-string tags and returns [] for an empty cache', () => {
    const qc = new QueryClient();
    expect(collectKnownTags(qc, ['companies', 'list'])).toEqual([]);
    qc.setQueryData(['companies', 'list', {}], { data: [{ tags: ['  ', 5, ' a '] }] });
    expect(collectKnownTags(qc, ['companies', 'list'])).toEqual(['a']);
  });
});

describe('buildTagOptions', () => {
  const known = ['key-account', 'qa-old', 'partner'];

  it('lists existing tags that are not applied yet when the draft is empty, with no create row', () => {
    expect(buildTagOptions('', known, ['partner'])).toEqual([
      { kind: 'existing', tag: 'key-account' },
      { kind: 'existing', tag: 'qa-old' },
    ]);
  });

  it('filters by the draft and adds a Create row for a new tag', () => {
    expect(buildTagOptions('qa-', known, [])).toEqual([
      { kind: 'existing', tag: 'qa-old' },
      { kind: 'create', tag: 'qa-' },
    ]);
    expect(buildTagOptions('qa-new', known, [])).toEqual([{ kind: 'create', tag: 'qa-new' }]);
  });

  it('offers no Create row for a tag that already exists or is already applied', () => {
    expect(buildTagOptions('QA-OLD', known, [])).toEqual([{ kind: 'existing', tag: 'qa-old' }]);
    expect(buildTagOptions('mine', known, ['Mine'])).toEqual([]);
  });

  it('trims the draft and caps the suggestions', () => {
    const many = Array.from({ length: 10 }, (_, i) => `tag-${i}`);
    const options = buildTagOptions('  tag ', many, [], 3);
    expect(options.filter((o) => o.kind === 'existing')).toHaveLength(3);
    expect(options.at(-1)).toEqual({ kind: 'create', tag: 'tag' });
  });
});
