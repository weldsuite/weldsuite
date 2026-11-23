import { describe, expect, it } from 'vitest';
import { SECTION_CATALOG, defaultSiteDocument, type Section } from '@weldsuite/storefront-theme/catalog';
import {
  addBlock,
  addSection,
  addSectionRefusal,
  canAddBlock,
  canRemoveSection,
  getList,
  isRequired,
  maxBlocks,
  moveBlock,
  moveItem,
  moveSection,
  removeBlock,
  removeSection,
  setList,
  toggleSectionHidden,
  uniqueId,
  updateBlockSettings,
  updateSectionSettings,
  type EditorContent,
} from './document';

const content = (): EditorContent => ({ document: defaultSiteDocument(), pages: {} });
const ids = (sections: Section[]) => sections.map((section) => section.id);

describe('lists', () => {
  it('reads and writes a group, a template and a content page without touching the others', () => {
    const start = content();
    const header = getList(start, { name: 'header' });
    const home = getList(start, { name: 'home' });
    expect(ids(header)).toEqual(['header']);
    expect(ids(home)).toEqual(['hero', 'featured', 'categories', 'story']);
    expect(getList(start, { name: 'content', pageId: 'pg_1' })).toEqual([]);

    const withPage = setList(start, { name: 'content', pageId: 'pg_1' }, home.slice(0, 1));
    expect(ids(getList(withPage, { name: 'content', pageId: 'pg_1' }))).toEqual(['hero']);
    expect(withPage.document).toBe(start.document);

    const withHome = setList(start, { name: 'home' }, home.slice(1));
    expect(ids(getList(withHome, { name: 'home' }))).toEqual(['featured', 'categories', 'story']);
    expect(withHome.document.groups).toBe(start.document.groups);
    expect(start.document.templates.home).toHaveLength(4);
  });
});

describe('ids', () => {
  it('makes an id that matches the pattern and is not taken', () => {
    expect(uniqueId('hero', [])).toBe('hero');
    expect(uniqueId('hero', ['hero', 'hero-2'])).toBe('hero-3');
    expect(uniqueId('Image With Text!', [])).toBe('image-with-text');
    expect(uniqueId('x'.repeat(80), [])).toMatch(/^[a-z0-9_-]{1,40}$/);
    expect(uniqueId('***', [])).toBe('item');
  });
});

describe('sections', () => {
  it('adds only sections the list allows, with their defaults and a unique id', () => {
    const home = defaultSiteDocument().templates.home;
    const result = addSection(home, 'hero', 'home');
    expect(result?.id).toBe('hero-2');
    const added = result!.sections.at(-1)!;
    expect(added.type).toBe('hero');
    expect(added.settings.heading).toBe('Welcome to our shop');
    expect(addSection(home, 'main-product', 'home')).toBeNull();
    expect(addSectionRefusal(home, 'main-product', 'home')).toBe('notAllowed');
    expect(addSectionRefusal(home, 'header', 'home')).toBe('notAllowed');
  });

  it('inserts after a given section', () => {
    const home = defaultSiteDocument().templates.home;
    const result = addSection(home, 'rich-text', 'home', 'hero');
    expect(ids(result!.sections)).toEqual(['hero', 'rich-text', 'featured', 'categories', 'story']);
  });

  it('gives a section with blocks an empty block list', () => {
    const result = addSection([], 'faq', 'page');
    expect(result!.sections[0]!.blocks).toEqual([]);
  });

  it('keeps to the per-list limit of a type and to 40 sections a list', () => {
    const withForm = addSection([], 'contact-form', 'content')!.sections;
    expect(addSectionRefusal(withForm, 'contact-form', 'content')).toBe('limit');
    expect(addSection(withForm, 'contact-form', 'content')).toBeNull();

    let full: Section[] = [];
    for (let i = 0; i < 40; i += 1) full = addSection(full, 'rich-text', 'home')!.sections;
    expect(full).toHaveLength(40);
    expect(new Set(ids(full)).size).toBe(40);
    expect(addSectionRefusal(full, 'hero', 'home')).toBe('listFull');
  });

  it('moves a section up and down, and not past either end', () => {
    const home = defaultSiteDocument().templates.home;
    expect(ids(moveSection(home, 'featured', -1))).toEqual(['featured', 'hero', 'categories', 'story']);
    expect(ids(moveSection(home, 'featured', 1))).toEqual(['hero', 'categories', 'featured', 'story']);
    expect(ids(moveSection(home, 'hero', -1))).toEqual(ids(home));
    expect(ids(moveSection(home, 'story', 1))).toEqual(ids(home));
    expect(moveItem(['a', 'b'], 5, 1)).toEqual(['a', 'b']);
  });

  it('hides and shows a section', () => {
    const home = defaultSiteDocument().templates.home;
    const hidden = toggleSectionHidden(home, 'hero');
    expect(hidden[0]!.hidden).toBe(true);
    const shown = toggleSectionHidden(hidden, 'hero');
    expect('hidden' in shown[0]!).toBe(false);
  });

  it('removes a section, but never a main section of its list', () => {
    const doc = defaultSiteDocument();
    expect(ids(removeSection(doc.templates.home, 'hero', 'home'))).toEqual(['featured', 'categories', 'story']);
    const product = doc.templates.product;
    expect(isRequired(product[0]!, 'product')).toBe(true);
    expect(canRemoveSection(product[0]!, 'product')).toBe(false);
    expect(ids(removeSection(product, 'main', 'product'))).toEqual(['main', 'related']);
    expect(ids(removeSection(product, 'related', 'product'))).toEqual(['main']);
    expect(canRemoveSection(doc.groups.header[0]!, 'header')).toBe(false);
    expect(canRemoveSection(doc.groups.footer[0]!, 'footer')).toBe(false);
    // An unknown type can always go (it would not pass the backend's check anyway).
    expect(canRemoveSection({ type: 'gone' }, 'home')).toBe(true);
  });

  it('every main section of the catalog is protected in its own list', () => {
    for (const [type, definition] of Object.entries(SECTION_CATALOG)) {
      for (const list of definition.required) expect(canRemoveSection({ type }, list), `${type} in ${list}`).toBe(false);
    }
  });

  it('changes a section’s settings and keeps the others', () => {
    const home = defaultSiteDocument().templates.home;
    const next = updateSectionSettings(home, 'hero', { heading: 'Spring sale' });
    expect(next[0]!.settings.heading).toBe('Spring sale');
    expect(next[0]!.settings.buttonLabel).toBe('Shop now');
    expect(next[1]).toBe(home[1]);
  });
});

describe('blocks', () => {
  const faq = () => addSection([], 'faq', 'page')!.sections;

  it('adds blocks up to the section’s maximum, of its own block types only', () => {
    let sections = faq();
    expect(maxBlocks(sections[0]!)).toBe(30);
    expect(addBlock(sections, 'faq', 'quote')).toBeNull();
    const first = addBlock(sections, 'faq', 'item')!;
    expect(first.id).toBe('item');
    expect(first.sections[0]!.blocks![0]!.settings).toEqual({ question: '', answer: '' });
    sections = first.sections;
    for (let i = 0; i < 29; i += 1) sections = addBlock(sections, 'faq', 'item')!.sections;
    expect(sections[0]!.blocks).toHaveLength(30);
    expect(canAddBlock(sections[0]!, 'item')).toBe(false);
    expect(addBlock(sections, 'faq', 'item')).toBeNull();
  });

  it('has no blocks for a section that takes none', () => {
    const hero = addSection([], 'hero', 'home')!.sections;
    expect(maxBlocks(hero[0]!)).toBe(0);
    expect(addBlock(hero, 'hero', 'item')).toBeNull();
  });

  it('moves, edits and removes a block', () => {
    let sections = faq();
    sections = addBlock(sections, 'faq', 'item')!.sections;
    sections = addBlock(sections, 'faq', 'item')!.sections;
    expect(sections[0]!.blocks!.map((b) => b.id)).toEqual(['item', 'item-2']);
    sections = moveBlock(sections, 'faq', 'item-2', -1);
    expect(sections[0]!.blocks!.map((b) => b.id)).toEqual(['item-2', 'item']);
    sections = updateBlockSettings(sections, 'faq', 'item', { question: 'Do you ship abroad?' });
    expect(sections[0]!.blocks![1]!.settings.question).toBe('Do you ship abroad?');
    sections = removeBlock(sections, 'faq', 'item-2');
    expect(sections[0]!.blocks!.map((b) => b.id)).toEqual(['item']);
  });
});
