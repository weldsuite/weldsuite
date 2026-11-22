import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceCategory, CommerceCategoryNode } from '@/hooks/queries/use-commerce-queries';

const env = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  tree: [] as CommerceCategoryNode[],
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/hooks/queries/use-commerce-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-commerce-queries')>()),
  useCreateCommerceCategory: () => ({ mutateAsync: env.create }),
  useUpdateCommerceCategory: () => ({ mutateAsync: env.update }),
  useCommerceCategoryTree: () => ({ data: { data: env.tree } }),
  useCategoryMembersPreview: (input: unknown) => ({
    data: input ? { data: { totalCount: 1, products: [{ id: 'prod_1', name: 'Linen shirt', sku: null }] } } : undefined,
    isLoading: false,
    error: null,
  }),
}));

import { CategoryDialog, categoryPayload } from './category-dialog';

function node(id: string, depth: number, children: CommerceCategoryNode[] = []): CommerceCategoryNode {
  return { ...category({ id, name: id, depth }), children };
}

function category(overrides: Partial<CommerceCategory> = {}): CommerceCategory {
  return {
    id: 'cat_1',
    name: 'Clothing',
    slug: 'clothing',
    description: 'Things to wear',
    parentId: null,
    path: null,
    depth: 0,
    type: 'manual',
    rules: null,
    rulesMatch: null,
    isActive: true,
    sortOrder: null,
    publishedAt: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

function open(existing?: CommerceCategory) {
  const onOpenChange = vi.fn();
  render(<CategoryDialog open onOpenChange={onOpenChange} category={existing} />);
  return { onOpenChange, user: userEvent.setup() };
}

async function pick(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement, option: string | RegExp) {
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.create.mockReset();
  env.update.mockReset();
  env.create.mockResolvedValue({ data: category() });
  env.update.mockResolvedValue({ data: category() });
  env.tree = [node('Clothing', 0, [node('Shirts', 1, [node('Linen', 2)])]), node('Shoes', 0)];
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('CategoryDialog', () => {
  it('creates a manual category, leaving out what is blank', async () => {
    const { user, onOpenChange } = open();
    await user.type(screen.getByLabelText('Name'), 'Outdoor');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(env.create).toHaveBeenCalledWith({ name: 'Outdoor', isActive: true, type: 'manual' });
    expect(toast.success).toHaveBeenCalledWith('Category created');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('needs a name', async () => {
    const { user } = open();
    expect(screen.getByLabelText('Name')).toBeRequired();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(env.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    // Focus goes to the field, which carries its message as its description.
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription();
  });

  it('names the type choices and the active switch without their hints, and describes them with the hints', () => {
    open();
    expect(screen.getByRole('radio', { name: 'Automated' })).toHaveAccessibleDescription(
      'Every product that matches the rules belongs to it.',
    );
    expect(screen.getByRole('switch', { name: 'Active' })).toHaveAccessibleDescription(
      'Inactive categories are hidden from your stores.',
    );
  });

  it('creates under a parent, with a slug, a description and inactive', async () => {
    const { user } = open();
    await user.type(screen.getByLabelText('Name'), 'Polo shirts');
    await user.type(screen.getByLabelText('Slug'), 'polos');
    await user.type(screen.getByLabelText('Description'), 'Short sleeves');
    await pick(user, screen.getByRole('combobox', { name: 'Parent category' }), /Shirts/);
    await user.click(screen.getByRole('switch', { name: 'Active' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(env.create).toHaveBeenCalledWith({
      name: 'Polo shirts',
      slug: 'polos',
      description: 'Short sleeves',
      parentId: 'Shirts',
      isActive: false,
      type: 'manual',
    });
  });

  it('creates an automated category with complete rules and previews its products', async () => {
    const { user } = open();
    await user.type(screen.getByLabelText('Name'), 'Cheap shirts');
    await user.click(screen.getByRole('radio', { name: /Automated/ }));
    // It starts with one rule to fill in; an empty one stops the save.
    expect(screen.getByText('Complete the rules to see which products match.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(env.create).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a value.')).toBeInTheDocument();
    // As after any failed submit, focus goes to the first field in error.
    expect(screen.getByLabelText('Value')).toHaveFocus();

    await pick(user, screen.getByRole('combobox', { name: 'Field' }), 'Price');
    await pick(user, screen.getByRole('combobox', { name: 'Condition' }), 'is less than');
    await user.type(screen.getByLabelText('Value'), ' 20 ');
    expect(screen.getByText('1 product matches')).toBeInTheDocument();
    expect(screen.getByText('Linen shirt')).toBeInTheDocument();

    await pick(user, screen.getByRole('combobox', { name: 'Products must match' }), 'Any rule');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(env.create).toHaveBeenCalledWith({
      name: 'Cheap shirts',
      isActive: true,
      type: 'automated',
      rules: [{ column: 'price', relation: 'less_than', condition: '20' }],
      rulesMatch: 'any',
    });
  });

  it('refuses an automated category without rules', async () => {
    const { user } = open();
    await user.type(screen.getByLabelText('Name'), 'Empty');
    await user.click(screen.getByRole('radio', { name: /Automated/ }));
    await user.click(screen.getByRole('button', { name: 'Remove rule' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(env.create).not.toHaveBeenCalled();
    expect(screen.getByText('An automated category needs at least one rule.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add rule' })).toHaveFocus();
  });

  it('edits a category, offering no parent inside its own subtree', async () => {
    const { user } = open(category({ id: 'Clothing', name: 'Clothing' }));
    await user.click(screen.getByRole('combobox', { name: 'Parent category' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent?.trim());
    expect(options).toEqual(['No parent (top level)', 'Shoes']);
    await user.click(screen.getByRole('option', { name: 'Shoes' }));
    const description = screen.getByLabelText('Description');
    await user.clear(description);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(env.update).toHaveBeenCalledWith({
      id: 'Clothing',
      data: { name: 'Clothing', slug: 'clothing', isActive: true, type: 'manual', parentId: 'Shoes', description: null },
    });
    expect(toast.success).toHaveBeenCalledWith('Category updated');
  });

  it('shows why a save failed', async () => {
    env.update.mockRejectedValue(new Error('Slug already used under this parent'));
    const { user, onOpenChange } = open(category());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(toast.error).toHaveBeenCalledWith('Slug already used under this parent');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('cancels', async () => {
    const { user, onOpenChange } = open();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('categoryPayload', () => {
  const values = {
    name: 'Sale',
    slug: undefined,
    description: undefined,
    parentId: null,
    isActive: true,
    type: 'manual' as const,
  };
  const rule = { column: 'tag' as const, relation: 'equals' as const, condition: ' sale ' };

  it('moves an edited category to the top level and keeps an unchanged description out', () => {
    const existing = category({ parentId: 'cat_0', description: 'Deals' });
    expect(categoryPayload({ ...values, description: 'Deals' }, [], 'all', existing)).toEqual({
      name: 'Sale',
      isActive: true,
      type: 'manual',
      parentId: null,
    });
  });

  it('drops the rules of a category turned manual', () => {
    const existing = category({ type: 'automated', rules: [rule], rulesMatch: 'all', description: null });
    expect(categoryPayload(values, [rule], 'all', existing)).toMatchObject({ rules: null, rulesMatch: null });
  });

  it('sends trimmed rules for an automated category', () => {
    expect(categoryPayload({ ...values, type: 'automated' }, [rule], 'all')).toEqual({
      name: 'Sale',
      isActive: true,
      type: 'automated',
      rules: [{ column: 'tag', relation: 'equals', condition: 'sale' }],
      rulesMatch: 'all',
    });
  });
});
