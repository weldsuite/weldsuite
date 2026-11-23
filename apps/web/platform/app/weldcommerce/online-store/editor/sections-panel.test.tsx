import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider, createStore } from 'jotai';
import { defaultSiteDocument } from '@weldsuite/storefront-theme/catalog';
import { createHistory } from '../lib/history';
import { getList, type ListKey } from '../lib/document';
import { historyAtom, selectionAtom } from './editor-state';
import { SectionsPanel } from './sections-panel';

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

function renderPanel(listKey: ListKey, title: string, readOnly = false) {
  const store = createStore();
  store.set(historyAtom, createHistory({ document: defaultSiteDocument(), pages: { pg_1: [] } }));
  render(
    <Provider store={store}>
      <SectionsPanel listKey={listKey} title={title} readOnly={readOnly} />
    </Provider>,
  );
  const list = (key: ListKey) => getList(store.get(historyAtom)!.present, key).map((section) => section.id);
  return { store, list };
}

const group = (name: string) => screen.getByRole('region', { name });

describe('SectionsPanel', () => {
  it('shows the header group, the template’s sections and the footer group', () => {
    renderPanel({ name: 'home' }, 'Home page');
    expect(within(group('Header')).getByRole('button', { name: /^Header/ })).toBeTruthy();
    const home = within(group('Home page'));
    expect(home.getAllByRole('listitem').map((item) => within(item).getAllByRole('button')[0]!.textContent)).toEqual([
      'Hero',
      'Featured products',
      'Category list',
      'Image with text',
    ]);
    expect(within(group('Footer')).getByRole('button', { name: /^Footer/ })).toBeTruthy();
  });

  it('never offers to remove or hide a main section, and does for the others', () => {
    renderPanel({ name: 'product' }, 'Product page');
    const product = within(group('Product page'));
    expect(product.getByText('(Main section: always on this page)')).toBeTruthy();
    expect(product.queryByRole('button', { name: 'Remove Product' })).toBeNull();
    expect(product.queryByRole('button', { name: 'Hide Product' })).toBeNull();
    expect(product.getByRole('button', { name: 'Remove Related products' })).toBeTruthy();
    expect(within(group('Header')).queryByRole('button', { name: 'Remove Header' })).toBeNull();
    expect(within(group('Footer')).queryByRole('button', { name: 'Remove Footer' })).toBeNull();
  });

  it('removes a section and says so', async () => {
    const { list } = renderPanel({ name: 'product' }, 'Product page');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove Related products' }));
    expect(list({ name: 'product' })).toEqual(['main']);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Related products removed'));
  });

  it('moves a section, keeps focus on the button used and announces the new position', async () => {
    const { list } = renderPanel({ name: 'home' }, 'Home page');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Move Featured products up' }));
    expect(list({ name: 'home' })).toEqual(['featured', 'hero', 'categories', 'story']);
    // At the top now, so Up is disabled and focus moves to Down.
    expect(screen.getByRole('button', { name: 'Move Featured products up' })).toHaveProperty('disabled', true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Featured products down' })));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Featured products moved to position 1 of 4'));
    await user.click(screen.getByRole('button', { name: 'Move Featured products down' }));
    expect(list({ name: 'home' })).toEqual(['hero', 'featured', 'categories', 'story']);
    expect(screen.getByRole('button', { name: 'Move Hero up' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Move Image with text down' })).toHaveProperty('disabled', true);
  });

  it('hides and shows a section', async () => {
    const { store } = renderPanel({ name: 'home' }, 'Home page');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Hide Hero' }));
    expect(store.get(historyAtom)!.present.document.templates.home[0]!.hidden).toBe(true);
    expect(within(group('Home page')).getByText('Hidden')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show Hero' }));
    expect(store.get(historyAtom)!.present.document.templates.home[0]!.hidden).toBeUndefined();
  });

  it('adds only sections the list allows, and selects the new one', async () => {
    const { store, list } = renderPanel({ name: 'product' }, 'Product page');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add a section to Product page' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).not.toContain('Product');
    expect(items).not.toContain('Header');
    // Related products is limited to one, and the product page has it.
    const related = within(menu).getByRole('menuitem', { name: /Related products/ });
    expect(related.getAttribute('aria-disabled')).toBe('true');
    await user.click(within(menu).getByRole('menuitem', { name: 'Questions and answers' }));
    expect(list({ name: 'product' })).toEqual(['main', 'related', 'faq']);
    expect(store.get(selectionAtom)).toEqual({ kind: 'section', list: { name: 'product' }, sectionId: 'faq' });
  });

  it('edits a content page’s own sections', async () => {
    const { list } = renderPanel({ name: 'content', pageId: 'pg_1' }, 'About us');
    const user = userEvent.setup();
    expect(within(group('About us')).getByText('No sections yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add a section to About us' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Text' }));
    expect(list({ name: 'content', pageId: 'pg_1' })).toEqual(['rich-text']);
  });

  it('adds, moves and removes the blocks of the selected section', async () => {
    const { store } = renderPanel({ name: 'home' }, 'Home page');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add a section to Home page' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Columns' }));
    expect(screen.getByText('0 of 12')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add column' }));
    await user.click(screen.getByRole('button', { name: 'Add column' }));
    const blocks = () => store.get(historyAtom)!.present.document.templates.home.at(-1)!.blocks!.map((block) => block.id);
    expect(blocks()).toEqual(['column', 'column-2']);
    expect(screen.getByText('2 of 12')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Move Column 2 up' }));
    expect(blocks()).toEqual(['column-2', 'column']);
    await user.click(screen.getByRole('button', { name: 'Remove Column 1' }));
    expect(blocks()).toEqual(['column']);
  });

  it('offers no changes to a member who may only look', () => {
    renderPanel({ name: 'home' }, 'Home page', true);
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add a section/ })).toBeNull();
    // Selecting a section to read its settings still works.
    expect(screen.getByRole('button', { name: 'Hero' })).toBeTruthy();
  });

  it('opens the theme and shop settings', async () => {
    const { store } = renderPanel({ name: 'home' }, 'Home page');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Theme settings' }));
    expect(store.get(selectionAtom)).toEqual({ kind: 'theme' });
    expect(screen.getByRole('button', { name: 'Theme settings' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Shop settings' }));
    expect(store.get(selectionAtom)).toEqual({ kind: 'shop' });
  });
});
