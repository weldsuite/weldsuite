import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CategoryRule, CategoryRulesMatch, CommerceProduct } from '@/hooks/queries/use-commerce-queries';

const env = vi.hoisted(() => ({
  preview: {
    data: undefined as { data: { totalCount: number; products: Partial<CommerceProduct>[] } } | undefined,
    isLoading: false,
    error: null as Error | null,
  },
  asked: [] as unknown[],
  debounce: true,
}));

vi.mock('@/hooks/use-debounce', () => ({
  // Off: the debounced value lags one step behind, as it does while typing.
  useDebounce: <T,>(value: T) => (env.debounce ? value : null),
}));
vi.mock('@/hooks/queries/use-commerce-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-commerce-queries')>()),
  useCategoryMembersPreview: (input: unknown) => {
    env.asked.push(input);
    return env.preview;
  },
}));

import { CategoryRulesEditor, MAX_RULES } from './category-rules-editor';

function Harness({ initial, showErrors = false }: Readonly<{ initial: CategoryRule[]; showErrors?: boolean }>) {
  const [state, setState] = useState<{ rules: CategoryRule[]; rulesMatch: CategoryRulesMatch }>({
    rules: initial,
    rulesMatch: 'all',
  });
  return (
    <>
      <CategoryRulesEditor rules={state.rules} rulesMatch={state.rulesMatch} onChange={setState} showErrors={showErrors} />
      <output data-testid="state">{JSON.stringify(state)}</output>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}') as {
  rules: CategoryRule[];
  rulesMatch: CategoryRulesMatch;
};

async function pick(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement, option: string) {
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
  env.preview = { data: undefined, isLoading: false, error: null };
  env.asked = [];
  env.debounce = true;
});

describe('CategoryRulesEditor', () => {
  it('offers the relations that suit the field, resetting one the new field does not allow', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ column: 'name', relation: 'contains', condition: 'shirt' }]} />);

    await pick(user, screen.getByRole('combobox', { name: 'Field' }), 'Tag');
    expect(state().rules[0]).toEqual({ column: 'tag', relation: 'equals', condition: 'shirt' });

    await user.click(screen.getByRole('combobox', { name: 'Condition' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['is equal to']);
    await user.keyboard('{Escape}');

    await pick(user, screen.getByRole('combobox', { name: 'Field' }), 'Stock');
    await pick(user, screen.getByRole('combobox', { name: 'Condition' }), 'is greater than');
    expect(state().rules[0]).toEqual({ column: 'inventoryQuantity', relation: 'greater_than', condition: 'shirt' });
  });

  it('adds and removes rules and switches between all and any', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ column: 'name', relation: 'contains', condition: 'shirt' }]} />);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.type(screen.getAllByLabelText('Value')[1], 'Acme');
    expect(state().rules).toEqual([
      { column: 'name', relation: 'contains', condition: 'shirt' },
      { column: 'name', relation: 'equals', condition: 'Acme' },
    ]);

    await user.click(screen.getAllByRole('button', { name: 'Remove rule' })[0]);
    expect(state().rules).toEqual([{ column: 'name', relation: 'equals', condition: 'Acme' }]);
    expect(screen.getByLabelText('Value')).toHaveValue('Acme');
    // The removed rule's button took focus with it: focus moves to the next rule's.
    expect(screen.getByRole('button', { name: 'Remove rule' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Remove rule' }));
    expect(screen.getByRole('button', { name: 'Add rule' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    await pick(user, screen.getByRole('combobox', { name: 'Products must match' }), 'Any rule');
    expect(state().rulesMatch).toBe('any');
    await pick(user, screen.getByRole('combobox', { name: 'Products must match' }), 'All rules');
    expect(state().rulesMatch).toBe('all');
  });

  it('marks a missing value and a value that is not a number', () => {
    render(
      <Harness
        showErrors
        initial={[
          { column: 'name', relation: 'contains', condition: '' },
          { column: 'price', relation: 'less_than', condition: 'cheap' },
        ]}
      />,
    );
    expect(screen.getByText('Enter a value.')).toBeInTheDocument();
    expect(screen.getByText('Enter a number.')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Value')[1]).toHaveAttribute('aria-invalid', 'true');
    // Each field carries its own message as its description.
    expect(screen.getAllByLabelText('Value')[0]).toHaveAccessibleDescription('Enter a value.');
    expect(screen.getAllByLabelText('Value')[1]).toHaveAccessibleDescription('Enter a number.');
  });

  it('asks for a rule when there is none', () => {
    render(<Harness showErrors initial={[]} />);
    expect(screen.getByText('An automated category needs at least one rule.')).toBeInTheDocument();
  });

  it('stops at the most rules a category can have', () => {
    const many = Array.from({ length: MAX_RULES }, (_, i) => ({ column: 'name' as const, relation: 'contains' as const, condition: `v${i}` }));
    render(<Harness initial={many} />);
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeDisabled();
    expect(screen.getByText('A category can have at most 50 rules.')).toBeInTheDocument();
  });
});

describe('CategoryMembersPreview (in the editor)', () => {
  const complete = [{ column: 'name' as const, relation: 'contains' as const, condition: ' shirt ' }];

  it('asks nothing while a rule is incomplete', () => {
    render(<Harness initial={[{ column: 'name', relation: 'contains', condition: '' }]} />);
    expect(screen.getByText('Complete the rules to see which products match.')).toBeInTheDocument();
    expect(env.asked.every((input) => input === null)).toBe(true);
  });

  it('names the first matching products and counts the rest', () => {
    env.preview.data = {
      data: {
        totalCount: 7,
        products: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Shirt ${i}`, sku: i === 0 ? 'S-0' : null })),
      },
    };
    render(<Harness initial={complete} />);
    expect(env.asked.at(-1)).toEqual({ rules: [{ column: 'name', relation: 'contains', condition: 'shirt' }], rulesMatch: 'all' });
    expect(screen.getByText('7 products match')).toBeInTheDocument();
    expect(screen.getByText('Shirt 0 · S-0')).toBeInTheDocument();
    expect(screen.queryByText('Shirt 5')).not.toBeInTheDocument();
    expect(screen.getByText('and 2 more')).toBeInTheDocument();
    // Only the count is announced, not every product name.
    expect(screen.getByText('7 products match').closest('[role="status"]')).not.toBeNull();
    expect(screen.getByText('Shirt 0 · S-0').closest('[role="status"]')).toBeNull();
  });

  it('says when nothing matches', () => {
    env.preview.data = { data: { totalCount: 0, products: [] } };
    render(<Harness initial={complete} />);
    expect(screen.getByText('No products match these rules yet.')).toBeInTheDocument();
  });

  it('waits while the rules are still changing or loading', () => {
    env.debounce = false;
    const { unmount } = render(<Harness initial={complete} />);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    unmount();
    env.debounce = true;
    env.preview.isLoading = true;
    render(<Harness initial={complete} />);
    expect(screen.queryByText(/products match/)).not.toBeInTheDocument();
  });

  it('says when the preview failed', () => {
    env.preview.error = new Error('boom');
    render(<Harness initial={complete} />);
    expect(screen.getByText('Could not preview the matching products.')).toBeInTheDocument();
  });
});
