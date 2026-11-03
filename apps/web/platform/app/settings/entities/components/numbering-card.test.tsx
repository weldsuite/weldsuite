import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NumberSequence } from '@/lib/api/domains/weldbooks';

const state = vi.hoisted(() => ({
  sequences: [] as NumberSequence[],
  mutateAsync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useNumberSequences: () => ({ data: state.sequences, isLoading: false }),
  useUpdateNumberSequences: () => ({ mutateAsync: state.mutateAsync, isPending: false }),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NumberingCard, changedSequences, rowError } from './numbering-card';

function seq(sequenceType: NumberSequence['sequenceType'], prefix: string, nextValue: number, padding = 4): NumberSequence {
  return { sequenceType, prefix, nextValue, padding, nextNumber: `${prefix}${String(nextValue).padStart(padding, '0')}` };
}

describe('numbering rows', () => {
  const saved = seq('invoice', 'INV-', 12);

  it('accepts a forward move and refuses a backward one', () => {
    expect(rowError({ prefix: '2026-', nextValue: '1001', padding: '0' }, saved)).toBeNull();
    expect(rowError({ prefix: 'INV-', nextValue: '11', padding: '4' }, saved)).toBe('backwards');
    expect(rowError({ prefix: 'INV-', nextValue: '1.5', padding: '4' }, saved)).toBe('nextValue');
    expect(rowError({ prefix: 'INV<', nextValue: '12', padding: '4' }, saved)).toBe('prefix');
    expect(rowError({ prefix: 'INV-', nextValue: '12', padding: '11' }, saved)).toBe('padding');
  });

  it('sends only the fields that changed', () => {
    const list = [saved, seq('bill', 'BILL-', 1)];
    expect(
      changedSequences(
        {
          invoice: { prefix: 'INV-', nextValue: '1001', padding: '4' },
          bill: { prefix: 'BILL-', nextValue: '1', padding: '4' },
        },
        list,
      ),
    ).toEqual([{ sequenceType: 'invoice', nextValue: 1001 }]);
  });
});

describe('NumberingCard', () => {
  beforeEach(() => {
    state.sequences = [seq('invoice', 'INV-', 12), seq('creditNote', 'CN-', 1), seq('bill', 'BILL-', 1), seq('journal', 'JE-', 40)];
    state.mutateAsync.mockReset().mockResolvedValue({ data: state.sequences });
  });

  it('continues the invoice numbering from a set number and saves it', async () => {
    render(<NumberingCard entityId="ent_1" canUpdate />);
    const next = screen.getAllByLabelText('Next number')[0];
    const prefix = screen.getAllByLabelText('Prefix')[0];
    fireEvent.change(prefix, { target: { value: '2026-' } });
    fireEvent.change(next, { target: { value: '1001' } });
    expect(screen.getByText('Next number: 2026-1001')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save numbering' }));
    await waitFor(() =>
      expect(state.mutateAsync).toHaveBeenCalledWith({
        entityId: 'ent_1',
        sequences: [{ sequenceType: 'invoice', prefix: '2026-', nextValue: 1001 }],
      }),
    );
  });

  it('explains a backward move and keeps Save off', () => {
    render(<NumberingCard entityId="ent_1" canUpdate />);
    fireEvent.change(screen.getAllByLabelText('Next number')[0], { target: { value: '5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('The next number can only go up: 12 or more.');
    expect(screen.getByRole('button', { name: 'Save numbering' })).toBeDisabled();
  });

  it('is read-only without permission to update entities', () => {
    render(<NumberingCard entityId="ent_1" canUpdate={false} />);
    expect(screen.getAllByLabelText('Next number')[0]).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save numbering' })).not.toBeInTheDocument();
  });
});
