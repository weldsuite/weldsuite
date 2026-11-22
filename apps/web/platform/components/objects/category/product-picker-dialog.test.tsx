import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  rows: [] as { id: string; name: string; sku?: string | null; featuredImageUrl?: string | null }[],
  isLoading: false,
  params: [] as unknown[],
}));

vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashProducts: (params: unknown) => {
    env.params.push(params);
    return { data: { data: env.rows }, isLoading: env.isLoading };
  },
}));

import { ProductPickerDialog } from './product-picker-dialog';

function open(existingIds: string[] = ['prod_1']) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(<ProductPickerDialog open onOpenChange={onOpenChange} existingIds={existingIds} onConfirm={onConfirm} />);
  return { onConfirm, onOpenChange, user: userEvent.setup() };
}

beforeEach(() => {
  env.rows = [
    { id: 'prod_1', name: 'Linen shirt', sku: 'L-1' },
    { id: 'prod_2', name: 'Oxford shirt', featuredImageUrl: 'https://img/2.png' },
    { id: 'prod_3', name: 'Wool coat' },
  ];
  env.isLoading = false;
  env.params = [];
});

describe('ProductPickerDialog', () => {
  it('shows products already in the category as added, and adds the chosen ones', async () => {
    const { user, onConfirm, onOpenChange } = open();
    expect(screen.getByRole('checkbox', { name: /Linen shirt/ })).toBeDisabled();
    expect(screen.getByText('Added')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add products' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /Oxford shirt/ }));
    await user.click(screen.getByText('Wool coat'));
    await user.click(screen.getByText('Wool coat'));
    await user.click(screen.getByText('Wool coat'));
    await user.click(screen.getByRole('button', { name: 'Add 2 products' }));
    expect(onConfirm).toHaveBeenCalledWith(['prod_2', 'prod_3']);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('searches the catalogue, and says how many products it found', async () => {
    const { user } = open();
    const status = screen.getAllByRole('status').find((el) => el.tagName === 'P');
    // Nothing to say before a search: the list is the catalogue.
    expect(status).toBeEmptyDOMElement();
    await user.type(screen.getByRole('searchbox', { name: 'Search products…' }), 'coat');
    expect(env.params.at(-1)).toEqual({ limit: 50, search: 'coat' });
    expect(status).toHaveTextContent('3 products found');
  });

  it('shows loading and no results', () => {
    env.isLoading = true;
    const { unmount } = render(<ProductPickerDialog open onOpenChange={vi.fn()} existingIds={[]} onConfirm={vi.fn()} />);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    unmount();
    env.isLoading = false;
    env.rows = [];
    open([]);
    expect(screen.getByText('No products found.')).toBeInTheDocument();
  });

  it('cancels and forgets the selection', async () => {
    const { user, onOpenChange, onConfirm } = open();
    await user.click(screen.getByRole('checkbox', { name: /Oxford shirt/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
