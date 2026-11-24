import { describe, expect, it } from 'vitest';
import type { MenuItem } from '@weldsuite/storefront-theme/catalog';
import { buildMenuSchema, buildNewMenuSchema, emptyLink, toMenuFormValues, toMenuItems, type MenuFormValues } from './menus';
import { buildNewPageSchema, newPageValues, slugify, toCreatePageInput, toUpdatePageInput } from './pages';

describe('menus', () => {
  const items: MenuItem[] = [
    { id: 'shop', label: 'Shop', link: { type: 'catalog' }, children: [{ id: 'shoes', label: 'Shoes', link: { type: 'category', id: 'cat_1' } }] },
    { id: 'about', label: 'About', link: { type: 'page', id: 'pg_1' } },
    { id: 'blog', label: 'Blog', link: { type: 'url', url: 'https://blog.example.com' } },
  ];

  it('round-trips the API’s items through the form', () => {
    expect(toMenuItems(toMenuFormValues({ title: 'Main', items }))).toEqual(items);
  });

  it('gives new links an id unique in the menu, and drops an empty sub-link list', () => {
    const values: MenuFormValues = {
      title: 'Main',
      items: [
        { ...emptyLink(), label: 'Shop', children: [] },
        { ...emptyLink(), itemId: 'shop', label: 'Shop again', children: [{ ...emptyLink(), label: 'Shop' }] },
      ],
    };
    const result = toMenuItems(values);
    expect(result.map((item) => item.id)).toEqual(['shop-2', 'shop']);
    expect(result[0]!.children).toBeUndefined();
    expect(result[1]!.children![0]!.id).toBe('shop-3');
  });

  it('wants a label, and a target for links that need one', () => {
    const schema = buildMenuSchema();
    const result = schema.safeParse({
      title: 'Main',
      items: [
        { itemId: '', label: '', linkType: 'catalog', target: '', children: [] },
        { itemId: '', label: 'Shoes', linkType: 'category', target: '', children: [] },
        { itemId: '', label: 'Out', linkType: 'url', target: 'javascript:alert(1)', children: [] },
      ],
    });
    expect(result.success).toBe(false);
    const issues = result.error!.issues.map((issue) => [issue.path.join('.'), issue.message]);
    expect(issues).toContainEqual(['items.0.label', 'Enter a label.']);
    expect(issues).toContainEqual(['items.1.target', 'Choose where the link goes.']);
    expect(issues).toContainEqual(['items.2.target', 'Use a path such as /products, or a full https:// address.']);
  });

  it('holds 100 links at most, sub-links included', () => {
    const link = { itemId: '', label: 'x', linkType: 'home' as const, target: '' };
    const values = { title: 'Big', items: Array.from({ length: 50 }, () => ({ ...link, children: [link] })) };
    expect(buildMenuSchema().safeParse(values).success).toBe(true);
    values.items.push({ ...link, children: [] });
    expect(buildMenuSchema().safeParse(values).error?.issues[0]?.message).toBe('A menu holds at most 100 links.');
  });

  it('refuses a handle that is taken or not lowercase with hyphens', () => {
    const schema = buildNewMenuSchema(['main', 'footer']);
    expect(schema.safeParse({ handle: 'sidebar', title: 'Sidebar' }).success).toBe(true);
    expect(schema.safeParse({ handle: 'main', title: 'Main' }).success).toBe(false);
    expect(schema.safeParse({ handle: 'Side Bar', title: 'Side' }).success).toBe(false);
  });
});

describe('pages', () => {
  it('makes slugs from titles', () => {
    expect(slugify('Über uns & Kontakt!')).toBe('uber-uns-kontakt');
    expect(slugify('  About   us  ')).toBe('about-us');
  });

  it('makes the same slugs as the regular expressions it used before', () => {
    // The old implementation, kept to show the two agree.
    const before = (title: string) =>
      title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100)
        .replace(/-+$/g, '');
    const titles = ['', ' ', '---', '!!!', '-Hello-', 'Über uns & Kontakt!', '  About   us  ', 'Crème brûlée', '日本語', `${'a'.repeat(99)} b`, `${'a'.repeat(100)} b`, `!${'a'.repeat(99)}!b`, 'x'.repeat(150)];
    for (const title of titles) expect(slugify(title), title).toBe(before(title));
    expect(slugify(`${'a'.repeat(99)} b`)).toBe('a'.repeat(99));
    expect(slugify('---')).toBe('');
  });

  it('starts a page from a template, in the shop’s language', () => {
    expect(newPageValues('about', 'nl')).toEqual({ template: 'about', title: 'Over ons', slug: 'about' });
    expect(newPageValues('terms', 'de')).toEqual({ template: 'terms', title: 'Terms and conditions', slug: 'terms' });
    expect(newPageValues('nope', 'en').template).toBe('blank');
  });

  it('creates a page with the template’s sections, and a slug from the title when left empty', () => {
    const body = toCreatePageInput({ template: 'contact', title: 'Get in touch', slug: '' });
    expect(body.slug).toBe('get-in-touch');
    expect(body.sections?.map((section) => section.type)).toEqual(['rich-text', 'contact-form']);
  });

  it('checks the slug', () => {
    const schema = buildNewPageSchema();
    expect(schema.safeParse({ template: 'blank', title: 'A', slug: '' }).success).toBe(true);
    expect(schema.safeParse({ template: 'blank', title: 'A', slug: 'Not OK' }).success).toBe(false);
    expect(schema.safeParse({ template: 'blank', title: '', slug: 'ok' }).success).toBe(false);
  });

  it('clears empty search engine texts', () => {
    expect(toUpdatePageInput({ title: ' About ', slug: 'about', seoTitle: ' ', seoDescription: 'Who we are', visible: false })).toEqual({
      title: 'About',
      slug: 'about',
      seoTitle: null,
      seoDescription: 'Who we are',
      visible: false,
    });
  });
});
