import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MultiSelectEditor } from './multi-select-editor';

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params?.value ? `${key}:${String(params.value)}` : key,
}));

beforeAll(() => {
  // cmdk / Radix need these; jsdom has neither.
  class RO {
    observe() { /* no-op */ }
    unobserve() { /* no-op */ }
    disconnect() { /* no-op */ }
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  Element.prototype.scrollIntoView = () => {};
});

function open(ui: React.ReactElement) {
  render(ui);
  fireEvent.click(screen.getByRole('button'));
  return screen.getByRole('combobox');
}

describe('MultiSelectEditor tag creation', () => {
  it('offers existing tags and creates a new one from the typed value', () => {
    const onChange = vi.fn();
    const input = open(
      <MultiSelectEditor value={['vip']} options={['vip', 'partner']} onChange={onChange} onCommit={vi.fn()} onCancel={vi.fn()} allowCreate />,
    );
    expect(screen.getByText('partner')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Brand New' } });
    const create = screen.getByText('sweep.entities.createOptionFromSearch:Brand New');
    fireEvent.click(create);
    expect(onChange).toHaveBeenCalledWith(['vip', 'Brand New']);
  });

  it('does not offer to create a tag that already exists (case-insensitive)', () => {
    const input = open(
      <MultiSelectEditor value={[]} options={['Partner']} onChange={vi.fn()} onCommit={vi.fn()} onCancel={vi.fn()} allowCreate />,
    );
    fireEvent.change(input, { target: { value: 'partner' } });
    expect(screen.queryByText(/createOptionFromSearch/)).not.toBeInTheDocument();
  });

  it('does not offer creation when allowCreate is off', () => {
    const input = open(<MultiSelectEditor value={[]} options={['a']} onChange={vi.fn()} onCommit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryByText(/createOptionFromSearch/)).not.toBeInTheDocument();
    expect(screen.getByText('sweep.entities.noOptionFound')).toBeInTheDocument();
  });
});
