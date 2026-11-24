import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SECTION_CATALOG, defaultSettings, type SettingValues } from '@weldsuite/storefront-theme/catalog';

const env = vi.hoisted(() => ({
  menus: { data: { data: [] as unknown[] }, isPending: false },
  pages: { data: { data: [] as unknown[] }, isPending: false },
  categories: { data: { data: [] as unknown[] }, isPending: false },
  products: { data: { data: [] as unknown[] }, isPending: false },
}));

vi.mock('@/hooks/queries/use-online-store-queries', () => ({
  useStoreMenus: () => env.menus,
  useStorePages: () => env.pages,
}));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({ useCommerceCategories: () => env.categories }));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({ useWeldstashProducts: () => env.products }));

import { SettingsForm } from './settings-form';

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.menus = { data: { data: [{ handle: 'main', title: 'Main menu', items: [], updatedAt: null }, { handle: 'sidebar', title: 'Sidebar', items: [], updatedAt: null }] }, isPending: false };
  env.pages = { data: { data: [{ id: 'pg_1', title: 'About us' }] }, isPending: false };
  env.categories = { data: { data: [{ id: 'cat_1', name: 'Shoes', path: null }] }, isPending: false };
  env.products = { data: { data: [{ id: 'prod_1', name: 'Blue sneaker', sku: 'SN-1' }] }, isPending: false };
});

function renderForm(type: string, values: SettingValues = defaultSettings(type), extra: Partial<Parameters<typeof SettingsForm>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <SettingsForm definitions={SECTION_CATALOG[type]!.settings} values={values} onChange={onChange} siteId="sfs_1" label={`Settings of ${type}`} {...extra} />,
  );
  return { onChange, ...view };
}

describe('SettingsForm', () => {
  it('generates a field per setting, by type, with its label, value and limits', () => {
    renderForm('hero');
    expect(screen.getByRole('form', { name: 'Settings of hero' })).toBeTruthy();
    expect(screen.getByLabelText('Heading')).toHaveProperty('value', 'Welcome to our shop');
    expect(screen.getByLabelText('Heading').getAttribute('maxlength')).toBe('200');
    expect(screen.getByLabelText('Text').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Button link')).toHaveProperty('value', '/products');
    expect(screen.getByLabelText('Image')).toHaveProperty('value', '');
    expect(screen.getByText('An https:// address of the image, or a path such as /logo.png.')).toBeTruthy();
    const overlay = screen.getByLabelText('Image darkening (%)');
    expect(overlay.getAttribute('type')).toBe('number');
    expect(overlay.getAttribute('min')).toBe('0');
    expect(overlay.getAttribute('max')).toBe('80');
    // Up to five options show as radio buttons.
    const height = screen.getByRole('radiogroup', { name: 'Height' });
    expect(within(height).getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual(['small', 'medium', 'large']);
    expect(within(height).getByRole('radio', { name: 'Large' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the Markdown help with a rich text setting', () => {
    renderForm('rich-text');
    expect(screen.getByText('Paragraphs, **bold**, *italic*, [links](https://…), lists (- item) and headings (## Heading)')).toBeTruthy();
  });

  it('passes on each valid change straight away', async () => {
    const { onChange } = renderForm('hero');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Heading'), '!');
    expect(onChange).toHaveBeenLastCalledWith('heading', 'Welcome to our shop!');
    await user.click(screen.getByRole('radio', { name: 'Small' }));
    expect(onChange).toHaveBeenLastCalledWith('height', 'small');
  });

  it('keeps an invalid value to itself and says what is wrong once the field is left', async () => {
    const { onChange } = renderForm('hero');
    const user = userEvent.setup();
    const overlay = screen.getByLabelText('Image darkening (%)');
    await user.clear(overlay);
    await user.type(overlay, '95');
    await user.tab();
    expect(await screen.findByText('Enter a number from 0 to 80.')).toBeTruthy();
    expect(overlay.getAttribute('aria-invalid')).toBe('true');
    expect(onChange).not.toHaveBeenCalledWith('overlay', 95);

    const link = screen.getByLabelText('Button link');
    await user.clear(link);
    await user.type(link, 'javascript:alert(1)');
    await user.tab();
    expect(await screen.findByText('Use a path such as /products, or a full https://, mailto: or tel: address.')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalledWith('buttonLink', 'javascript:alert(1)');
  });

  it('turns a checkbox setting on and off', async () => {
    const { onChange } = renderForm('featured-products');
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Show “View all” link' }));
    expect(onChange).toHaveBeenLastCalledWith('showViewAll', false);
  });

  it('picks a menu by handle from the store’s menus', async () => {
    const { onChange } = renderForm('header');
    const user = userEvent.setup();
    const menu = screen.getByRole('combobox', { name: 'Menu' });
    expect(menu.textContent).toContain('Main menu');
    await user.click(menu);
    await user.click(await screen.findByRole('option', { name: 'Sidebar' }));
    expect(onChange).toHaveBeenLastCalledWith('menu', 'sidebar');
  });

  it('picks a category from the catalogue', async () => {
    const { onChange } = renderForm('featured-products');
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'Shoes' }));
    expect(onChange).toHaveBeenLastCalledWith('category', 'cat_1');
  });

  it('shows the field errors of a refused save on their fields', () => {
    renderForm('hero', defaultSettings('hero'), { serverErrors: { heading: 'The heading is too long.', unknown: 'Ignored' } });
    return waitFor(() => {
      expect(screen.getByText('The heading is too long.')).toBeTruthy();
      expect(screen.getByLabelText('Heading').getAttribute('aria-invalid')).toBe('true');
    });
  });

  it('follows values changed from outside (undo, redo)', async () => {
    const values = defaultSettings('hero');
    const { rerender, onChange } = renderForm('hero', values);
    rerender(
      <SettingsForm
        definitions={SECTION_CATALOG.hero!.settings}
        values={{ ...values, heading: 'Back to this' }}
        onChange={onChange}
        siteId="sfs_1"
        label="Settings of hero"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Heading')).toHaveProperty('value', 'Back to this'));
  });

  it('is read-only for a member who may only look', () => {
    renderForm('hero', defaultSettings('hero'), { readOnly: true });
    expect(screen.getByLabelText('Heading').matches(':disabled')).toBe(true);
  });
});
