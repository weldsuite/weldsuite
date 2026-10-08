import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { en } from '@weldsuite/i18n/locales/en';
import { schema, type SchemaEditor } from './schema';
import { filterSlashMenuItems, getPageLinkItems, getSlashMenuItems, type PageLinkSource } from './slash-menu';

const strings = en.blockEditor;

function createEditor(): SchemaEditor {
  const editor = BlockNoteEditor.create({ schema });
  editor.mount(document.createElement('div'));
  return editor;
}

function setup(pageLinks?: PageLinkSource) {
  const editor = createEditor();
  const items = getSlashMenuItems(editor, { strings, locale: 'en', pageLinks });
  const run = (key: string) => {
    const item = items.find((candidate) => candidate.key === key);
    if (!item) throw new Error(`no slash item "${key}"`);
    item.onItemClick();
  };
  /** Put the cursor in a paragraph holding `text`, as the first block. */
  const startWith = (text: string) => {
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: text }]);
    editor.setTextCursorPosition(editor.document[0]!, 'end');
  };
  return { editor, items, run, startWith };
}

describe('getSlashMenuItems', () => {
  it('lists the commands in Notion order, grouped', () => {
    const { items } = setup({ create: vi.fn(), search: () => [] });
    const byGroup = new Map<string, string[]>();
    for (const item of items) byGroup.set(item.group!, [...(byGroup.get(item.group!) ?? []), item.key]);

    expect([...byGroup.keys()]).toEqual(['Basic blocks', 'Media', 'Embeds', 'Advanced', 'Inline']);
    expect(byGroup.get('Basic blocks')).toEqual([
      'paragraph', 'page', 'check_list', 'heading', 'heading_2', 'heading_3', 'table', 'bullet_list',
      'numbered_list', 'toggle_list', 'quote', 'divider', 'linkToPage', 'callout',
    ]);
    expect(byGroup.get('Media')).toEqual(['image', 'video', 'audio', 'code_block', 'file', 'bookmark']);
    expect(byGroup.get('Embeds')).toEqual([
      'embed', 'youtube', 'vimeo', 'loom', 'figma', 'googleDrive', 'googleMaps', 'codepen', 'miro',
    ]);
    expect(byGroup.get('Advanced')).toEqual([
      'tableOfContents', 'toggle_heading', 'toggle_heading_2', 'toggle_heading_3',
    ]);
    expect(byGroup.get('Inline')).toEqual(['date', 'emoji']);
  });

  it('only inserts: no formatting, duplicate or delete commands', () => {
    const keys = setup().items.map((item) => item.key);

    expect(keys.filter((key) => /^(turnInto|color|background):|^(duplicate|delete)$/.test(key))).toEqual([]);
  });

  it('gives every command a unique key, a title and an icon', () => {
    const { items } = setup({ create: vi.fn(), search: () => [] });

    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    for (const item of items) {
      expect(item.title, item.key).toBeTruthy();
      expect(item.icon, item.key).toBeTruthy();
    }
  });

  it('leaves the page commands out when the host has no pages', () => {
    const keys = setup().items.map((item) => item.key);

    expect(keys).not.toContain('page');
    expect(keys).not.toContain('linkToPage');
    expect(keys).toContain('callout');
  });
});

describe('slash commands', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it.each([
    ['callout', 'callout'],
    ['bookmark', 'bookmark'],
    ['tableOfContents', 'tableOfContents'],
    ['toggle_list', 'toggleListItem'],
  ])('%s turns the empty block into a %s block', (key, type) => {
    ctx.startWith('');
    ctx.run(key);

    expect(ctx.editor.document[0]!.type).toBe(type);
  });

  it('inserts a new block after one that already has text', () => {
    ctx.startWith('keep me');
    ctx.run('callout');

    expect(ctx.editor.document.map((block) => block.type).slice(0, 2)).toEqual(['paragraph', 'callout']);
  });

  it('embed commands create an embed block hinted with their provider', () => {
    ctx.startWith('');
    ctx.run('youtube');

    expect(ctx.editor.document[0]).toMatchObject({ type: 'embed', props: { provider: 'youtube', url: '' } });
  });

  it('date inserts today in the given locale', () => {
    ctx.startWith('');
    ctx.run('date');

    const expected = new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(new Date());
    expect(ctx.editor.document[0]!.content).toEqual([expect.objectContaining({ text: `${expected} ` })]);
  });

  it('page creates a sub-page through the host and links to it', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'kp_1', title: 'Untitled', href: '/weldknow/page/kp_1' });
    ctx = setup({ create, search: () => [] });
    ctx.startWith('');
    ctx.run('page');
    await vi.waitFor(() => expect(ctx.editor.document[0]!.content).not.toEqual([]));

    expect(create).toHaveBeenCalledOnce();
    expect(ctx.editor.document[0]!.content).toEqual([
      expect.objectContaining({ type: 'link', href: '/weldknow/page/kp_1' }),
    ]);
  });
});

describe('filterSlashMenuItems', () => {
  const titles = (query: string) =>
    filterSlashMenuItems(setup({ create: vi.fn(), search: () => [] }).items, query).map((item) => item.title);

  it('returns everything for an empty query', () => {
    expect(titles('')).toHaveLength(setup({ create: vi.fn(), search: () => [] }).items.length);
  });

  it('matches at the start of a word, not inside one', () => {
    // "red" is inside "Numbered" and the alias "unordered"; "able" inside "Table".
    expect(titles('red')).toEqual([]);
    expect(titles('able')).toEqual([]);
    expect(titles('tab')).toEqual(['Table', 'Table of contents']);
  });

  it('finds commands by their Notion names and shorthands', () => {
    expect(titles('todo')[0]).toBe('Check List');
    expect(titles('text')[0]).toBe('Paragraph');
    expect(titles('h2')[0]).toBe('Heading 2');
    expect(titles('bulleted')[0]).toBe('Bullet List');
    expect(titles('toc')).toEqual(['Table of contents']);
  });

  it('puts Embed first for "embed", ahead of the media blocks', () => {
    expect(titles('embed')).toEqual(['Embed']);
  });

  it('keeps multi-word queries working', () => {
    expect(titles('heading 2')).toEqual(['Heading 2', 'Toggle Heading 2']);
    expect(titles('link to page')).toEqual(['Link to page']);
  });

  it('returns nothing when no command matches', () => {
    expect(titles('zzzz')).toEqual([]);
  });
});

describe('getPageLinkItems', () => {
  it('inserts a link to the chosen page', () => {
    const { editor, startWith } = setup();
    startWith('see ');
    const [item] = getPageLinkItems(editor, [{ id: 'kp_2', title: '', href: '/weldknow/page/kp_2' }], 'Untitled');

    expect(item!.title).toBe('Untitled');
    item!.onItemClick();
    expect(editor.document[0]!.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'see ' }),
      expect.objectContaining({ type: 'link', href: '/weldknow/page/kp_2' }),
      expect.objectContaining({ type: 'text', text: ' ' }),
    ]);
  });
});
