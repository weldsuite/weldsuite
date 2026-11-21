import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrderFilters } from './order-filters';

function renderFilters(values = {}) {
  const onChange = vi.fn();
  const onClear = vi.fn();
  render(<OrderFilters values={values} onChange={onChange} onClear={onClear} />);
  return { onChange, onClear, user: userEvent.setup() };
}

// Radix Select reads pointer capture and scrolls the chosen option into view; jsdom has neither.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe('OrderFilters', () => {
  it('has a named group with each filter labelled', () => {
    renderFilters();
    expect(screen.getByLabelText('Filter orders').tagName).toBe('SEARCH');
    for (const name of ['Status', 'Payment', 'Fulfilment', 'Source']) {
      expect(screen.getByRole('combobox', { name })).toBeTruthy();
    }
    expect(screen.getByLabelText('From')).toBeTruthy();
    expect(screen.getByLabelText('To')).toBeTruthy();
  });

  it('shows no Clear button until a filter is set', () => {
    renderFilters();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('reports a chosen status', async () => {
    const { user, onChange } = renderFilters();
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Cancelled' }));
    expect(onChange).toHaveBeenCalledWith('status', 'cancelled');
  });

  it('reports a channel and clearing a filter back to all', async () => {
    const { user, onChange } = renderFilters({ source: 'shopify' });
    await user.click(screen.getByRole('combobox', { name: 'Source' }));
    await user.click(await screen.findByRole('option', { name: 'All sources' }));
    expect(onChange).toHaveBeenCalledWith('source', undefined);
  });

  it('reports the date range, and stops the range from running backwards', () => {
    const { onChange } = renderFilters({ from: '2026-11-01', to: '2026-11-30' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-05' } });
    expect(onChange).toHaveBeenCalledWith('from', '2026-11-05');
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('to', undefined);
    expect(screen.getByLabelText('From').getAttribute('max')).toBe('2026-11-30');
    expect(screen.getByLabelText('To').getAttribute('min')).toBe('2026-11-01');
  });

  it('clears every filter at once', async () => {
    const { user, onClear } = renderFilters({ status: 'pending' });
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalled();
  });
});
