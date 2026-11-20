import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatVisual as Spec } from '@weldsuite/app-api-client/schemas/chat-visuals';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns], getLocale: () => 'en' };
});

// The chart wrappers come from the UI library, which has its own Recharts: stand in for them.
vi.mock('@weldsuite/ui/components/chart', () => ({
  ChartContainer: ({ children }: { children?: ReactNode }) => <div data-testid="chart">{children}</div>,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
}));

const openSheet = vi.fn();
const push = vi.fn();
vi.mock('@/components/entity-sheet/use-entity-sheet', () => ({ useEntitySheet: () => ({ open: openSheet }) }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/app/weldchat/hooks/use-entity-title', () => ({
  hasEntityTitleLookup: (type: string) => type === 'ticket',
  useEntityTitle: (_type: string, id: string) =>
    id === 'tkt_1' ? { status: 'ok', title: 'Renamed ticket' } : { status: 'loading', title: null },
}));

import { ChatVisual } from './chat-visual';
import { ChatVisualActionsProvider } from './visual-actions-context';
import { seriesColor, toSlices } from './visual-chart';

function renderVisual(visual: Spec, ask?: (prompt: string) => void) {
  return render(
    <ChatVisualActionsProvider ask={ask}>
      <ChatVisual visual={visual} />
    </ChatVisualActionsProvider>,
  );
}

const stats: Spec = {
  type: 'stats',
  title: 'This month',
  items: [
    { label: 'Revenue', value: 48210, format: { style: 'currency', currency: 'EUR' }, change: 12.5, changeLabel: 'vs last month' },
    { label: 'Open tickets', value: 23, change: 8, positiveIsGood: false },
  ],
};

const table: Spec = {
  type: 'table',
  title: 'Deals',
  columns: [{ label: 'Deal' }, { label: 'Amount', format: { style: 'currency', currency: 'EUR' } }],
  rows: Array.from({ length: 12 }, (_, i) => [`Deal ${i + 1}`, (i + 1) * 1000]),
};

describe('stat tiles', () => {
  it('formats values and colours the change by whether a rise is good', () => {
    renderVisual(stats);
    expect(screen.getByText('€48,210.00')).toBeTruthy();
    expect(screen.getByText('+12.5%').closest('span')?.className).toContain('emerald');
    // More open tickets is bad.
    expect(screen.getByText('+8%').closest('span')?.className).toContain('destructive');
  });

  it('asks about a tile when the chat allows it', () => {
    const ask = vi.fn();
    renderVisual(stats, ask);
    fireEvent.click(screen.getByText('Revenue'));
    expect(ask).toHaveBeenCalledWith('Tell me more about “Revenue” (€48,210.00) in “This month”.');
  });

  it('has no ask buttons without a chat to ask in', () => {
    renderVisual(stats);
    expect(screen.queryByTitle('Ask about Revenue')).toBeNull();
  });
});

describe('table', () => {
  it('shows the first rows and offers the rest', () => {
    renderVisual(table);
    const body = screen.getAllByRole('rowgroup')[1];
    expect(within(body).getAllByRole('row')).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Show all 12 rows' })).toBeTruthy();
  });

  it('sorts numbers high to low first, then back', () => {
    renderVisual(table);
    fireEvent.click(screen.getByTitle('Sort by Amount'));
    const firstRow = () => within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row')[0].textContent;
    expect(firstRow()).toContain('Deal 12');
    fireEvent.click(screen.getByTitle('Sort by Amount'));
    expect(firstRow()).toContain('Deal 1€');
  });

  it('asks about a row', () => {
    const ask = vi.fn();
    renderVisual(table, ask);
    fireEvent.click(screen.getByText('Deal 3'));
    expect(ask).toHaveBeenCalledWith('Tell me more about “Deal 3 · 3000” in “Deals”.');
  });
});

describe('record cards', () => {
  const records: Spec = {
    type: 'records',
    items: [
      { entityType: 'ticket', id: 'tkt_1', label: 'Old title', status: 'Open' },
      { entityType: 'task', id: 'tsk_1', label: 'A task' },
    ],
  };

  it('shows the live title and opens the record', () => {
    renderVisual(records);
    expect(screen.getByText('Renamed ticket')).toBeTruthy();
    expect(screen.queryByText('Old title')).toBeNull();
    fireEvent.click(screen.getByText('Renamed ticket'));
    expect(openSheet).toHaveBeenCalledWith('ticket', 'tkt_1');
  });

  it('keeps the snapshot label for a type without a title lookup', () => {
    renderVisual(records);
    expect(screen.getByText('A task')).toBeTruthy();
  });
});

describe('chart', () => {
  const chart: Spec = {
    type: 'chart',
    kind: 'bar',
    title: 'Tickets per status',
    labels: ['Open', 'Solved'],
    series: [{ name: 'Tickets', values: [3, 9] }],
    caption: 'Today',
  };

  it('has a title, caption, actions and a data table for screen readers', () => {
    renderVisual(chart);
    expect(screen.getByText('Tickets per status', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy();
    const data = screen.getByRole('table');
    expect(within(data).getAllByRole('row').map((row) => row.textContent)).toEqual(['Tickets', 'Open3', 'Solved9']);
  });

  it('adds the smallest slices of a pie up as Other', () => {
    const labels = Array.from({ length: 10 }, (_, i) => `L${i}`);
    const slices = toSlices(
      { ...chart, kind: 'pie', labels, series: [{ name: 'x', values: labels.map((_, i) => i + 1) }] } as never,
      'Other',
    );
    expect(slices).toHaveLength(8);
    expect(slices.at(-1)).toEqual({ label: 'Other', value: 1 + 2 + 3, index: -1 });
  });

  it('takes the theme colours, then lighter mixes', () => {
    expect(seriesColor(0)).toBe('var(--chart-1)');
    expect(seriesColor(5)).toContain('color-mix');
  });
});
