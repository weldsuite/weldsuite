import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';
import type { RaidMatrix } from '@weldsuite/app-api-client/domains/project-control';

// The matrix only needs the translations; the rest of the i18n provider is not under test.
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    language: 'en',
    t: en,
    plural: (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, 'en'),
    format: interpolate,
  }),
}));

import { RiskMatrix } from './risk-matrix';

/** 25 cells with the given counts, as `GET /api/project-raid/matrix` answers. */
function matrixWith(counts: Record<string, number>, residual = false): RaidMatrix {
  const cells = [];
  for (let probability = 1; probability <= 5; probability++) {
    for (let impact = 1; impact <= 5; impact++) {
      cells.push({ probability, impact, count: counts[`${probability}-${impact}`] ?? 0 });
    }
  }
  return { residual, total: Object.values(counts).reduce((sum, count) => sum + count, 0), cells };
}

function setup(overrides: Partial<Parameters<typeof RiskMatrix>[0]> = {}) {
  const props = {
    matrix: matrixWith({ '4-5': 2, '3-3': 1 }),
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    residual: false,
    onResidualChange: vi.fn(),
    selected: null,
    onSelect: vi.fn(),
    ...overrides,
  };
  render(<RiskMatrix {...props} />);
  return props;
}

describe('RiskMatrix', () => {
  it('shows 25 cells with the counts of the matrix', () => {
    setup();
    expect(screen.getAllByRole('button', { name: /^Probability \d, impact \d:/ })).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Probability 4, impact 5: 2 risks' })).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Probability 3, impact 3: 1 risk' })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: 'Probability 1, impact 1: 0 risks' })).toHaveTextContent('');
  });

  it('names the axes and the four bands', () => {
    setup();
    expect(screen.getByText('Almost certain')).toBeInTheDocument();
    expect(screen.getByText('Negligible')).toBeInTheDocument();
    for (const legend of ['Low 1–4', 'Medium 5–9', 'High 10–16', 'Critical 20–25']) {
      expect(screen.getByText(legend)).toBeInTheDocument();
    }
  });

  it('selects the clicked cell', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Probability 4, impact 5: 2 risks' }));
    expect(props.onSelect).toHaveBeenCalledWith({ probability: 4, impact: 5 });
  });

  it('clears the selection when the selected cell is clicked again', async () => {
    const props = setup({ selected: { probability: 4, impact: 5 } });
    const cell = screen.getByRole('button', { name: 'Probability 4, impact 5: 2 risks' });
    expect(cell).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(cell);
    expect(props.onSelect).toHaveBeenCalledWith(null);
  });

  it('switches between the current score and the one after mitigation', async () => {
    const props = setup();
    const group = screen.getByRole('group', { name: 'Score shown' });
    expect(within(group).getByRole('button', { name: 'Current' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(group).getByRole('button', { name: 'After mitigation' }));
    expect(props.onResidualChange).toHaveBeenCalledWith(true);
  });

  it('marks the after-mitigation view', () => {
    setup({ residual: true, matrix: matrixWith({ '2-4': 1 }, true) });
    const group = screen.getByRole('group', { name: 'Score shown' });
    expect(within(group).getByRole('button', { name: 'After mitigation' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Probability 2, impact 4: 1 risk' })).toHaveTextContent('1');
  });

  it('offers a retry when the matrix could not be loaded', async () => {
    const props = setup({ matrix: undefined, isError: true });
    expect(screen.getByRole('alert')).toHaveTextContent('The matrix could not be loaded.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows no counts while loading', () => {
    setup({ matrix: undefined, isLoading: true });
    expect(screen.getByRole('button', { name: 'Probability 4, impact 5: 0 risks' })).toHaveTextContent('');
  });
});
