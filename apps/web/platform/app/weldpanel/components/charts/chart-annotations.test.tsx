import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import type { PanelAnnotationDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { en } from '@weldsuite/i18n/locales/en';
import { ChartAnnotationsProvider } from './annotations-context';
import {
  ChartAnnotations,
  NO_CHART_ANNOTATIONS,
  annotationChartClick,
  annotationMarkLines,
  annotationTooltipActive,
  type AnnotatableRow,
  type AnnotationMark,
  type ChartAnnotationsApi,
} from './chart-annotations';

const state = vi.hoisted(() => ({
  allowed: new Set(['panel_reports:create']),
  annotations: [] as unknown[],
  query: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.allowed.has(key) }));
vi.mock('@/lib/router', () => ({ useSearchParams: () => new URLSearchParams('report=wpr_1') }));
vi.mock('@/app/weldpanel/lib/use-current-project', () => ({ useCurrentProject: () => ({ project: { id: 'wpp_1' } }) }));
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useWeldPanelAnnotations: (query: unknown, enabled: boolean) => {
    state.query(query, enabled);
    return { data: state.annotations };
  },
}));
vi.mock('@/app/weldpanel/components/annotation-dialogs', () => ({
  AnnotationEditDialog: ({ defaultOccurredAt, reportId }: { defaultOccurredAt: string; reportId: string | null }) => (
    <div role="dialog" aria-label="new annotation" data-at={defaultOccurredAt} data-report={reportId ?? ''} />
  ),
  AnnotationsListDialog: ({ from, to }: { from?: string; to?: string }) => <div role="dialog" aria-label="annotations" data-from={from} data-to={to} />,
}));

const ta = en.weldpanel.collab.annotations;

function annotation(overrides: Partial<PanelAnnotationDto> = {}): PanelAnnotationDto {
  return {
    id: 'wpan_1',
    projectId: 'wpp_1',
    reportId: null,
    occurredAt: '2026-11-02T09:00:00.000Z',
    label: 'Pricing page launched',
    description: 'Three plans instead of four.',
    createdByUserId: 'user_1',
    createdAt: '2026-11-02T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
    ...overrides,
  };
}

const ROWS = [
  { label: 'Nov 1', bucket: '2026-11-01' },
  { label: 'Nov 2', bucket: '2026-11-02' },
  { label: 'Nov 3', bucket: '2026-11-03' },
];

/** Shows what a chart body gets, with buttons for what a chart would do with it. */
function Probe({ api }: Readonly<{ api: ChartAnnotationsApi }>) {
  return (
    <div>
      <p data-testid="marks">{api.marks.map((m) => `${m.label}:${m.annotations.length}`).join(',')}</p>
      <button type="button" onClick={() => api.setHovered({ label: 'Nov 2', x: 600, y: 200 })}>
        hover
      </button>
      <button type="button" onClick={() => api.setHovered(null)}>
        leave
      </button>
      {api.onPickIndex && (
        <button type="button" onClick={() => api.onPickIndex?.(0)}>
          add
        </button>
      )}
      <button type="button" onClick={() => api.onPickMark?.()}>
        list
      </button>
    </div>
  );
}

function renderChart(rows: readonly AnnotatableRow[] = ROWS, enabled = true) {
  return render(
    <ChartAnnotationsProvider enabled={enabled}>
      <ChartAnnotations rows={rows}>{(api) => <Probe api={api} />}</ChartAnnotations>
    </ChartAnnotationsProvider>,
  );
}

describe('ChartAnnotations', () => {
  beforeEach(() => {
    state.allowed = new Set(['panel_reports:create']);
    state.annotations = [annotation(), annotation({ id: 'wpan_2', label: 'Newsletter sent', description: null }), annotation({ id: 'wpan_3', occurredAt: '2026-11-03T10:00:00.000Z', label: 'Bug fixed' })];
    state.query.mockReset();
  });
  afterEach(cleanup);

  it('gives the chart no markers and asks for nothing where annotations are off', () => {
    renderChart(ROWS, false);
    expect(screen.getByTestId('marks').textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'add' })).toBeNull();
    expect(state.query).not.toHaveBeenCalled();
  });

  it('gives a chart over something other than dates no markers', () => {
    renderChart([{ label: '1' }, { label: '2' }]);
    expect(screen.getByTestId('marks').textContent).toBe('');
    expect(state.query).not.toHaveBeenCalled();
  });

  it("asks for the chart's range and the open report's own, and marks each date that has some", () => {
    renderChart();
    const [query, enabled] = state.query.mock.calls.at(-1)!;
    expect(enabled).toBe(true);
    expect(query).toMatchObject({ projectId: 'wpp_1', reportId: 'wpr_1', from: '2026-11-01T00:00:00.000Z' });
    expect(screen.getByTestId('marks').textContent).toBe('Nov 2:2,Nov 3:1');
  });

  it('shows the notes of a hovered marker in a card, and hides it again', () => {
    renderChart();
    fireEvent.click(screen.getByRole('button', { name: 'hover' }));
    expect(screen.getByText('Pricing page launched')).toBeTruthy();
    expect(screen.getByText('Three plans instead of four.')).toBeTruthy();
    expect(screen.getByText('Newsletter sent')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'leave' }));
    expect(screen.queryByText('Pricing page launched')).toBeNull();
  });

  it('adds an annotation at the date clicked, and lists them from a marker', async () => {
    renderChart();
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    const add = await screen.findByRole('dialog', { name: 'new annotation' });
    expect(add.getAttribute('data-at')).toBe('2026-11-01T12:00:00.000Z');
    expect(add.getAttribute('data-report')).toBe('wpr_1');
    fireEvent.click(screen.getByRole('button', { name: 'list' }));
    expect((await screen.findByRole('dialog', { name: 'annotations' })).getAttribute('data-from')).toBe('2026-11-01T00:00:00.000Z');
  });

  it('offers no adding to someone who may not create annotations', () => {
    state.allowed = new Set();
    renderChart();
    expect(screen.queryByRole('button', { name: 'add' })).toBeNull();
  });
});

describe('annotation markers', () => {
  afterEach(cleanup);

  const mark: AnnotationMark = { label: 'Nov 2', annotations: [annotation()] };
  type Line = ReactElement<{ stroke: string; label: (props: { viewBox?: { x?: number; y?: number; height?: number } }) => ReactNode }>;

  function badge(api: ChartAnnotationsApi, viewBox?: { x?: number; y?: number; height?: number }) {
    const [line] = annotationMarkLines(api) as Line[];
    return render(<svg>{line!.props.label({ viewBox })}</svg>);
  }

  it('draws a round marker at the bottom of the plot that names its notes', () => {
    const setHovered = vi.fn();
    badge({ marks: [mark], setHovered }, { x: 120, y: 8, height: 218 });
    const marker = screen.getByRole('button', { name: `${ta.button}: Pricing page launched` });
    expect(marker.getAttribute('transform')).toBe('translate(120, 212)');
    fireEvent.mouseEnter(marker);
    expect(setHovered).toHaveBeenLastCalledWith({ label: 'Nov 2', x: 120, y: 212 });
    fireEvent.mouseLeave(marker);
    expect(setHovered).toHaveBeenLastCalledWith(null);
    fireEvent.focus(marker);
    fireEvent.blur(marker);
    expect(setHovered).toHaveBeenCalledTimes(4);
  });

  it('opens the list on a click or Enter, not on other keys', () => {
    const onPickMark = vi.fn();
    badge({ marks: [mark], setHovered: vi.fn(), onPickMark }, { x: 0, y: 0, height: 100 });
    const marker = screen.getByTestId('weldpanel-annotation-marker');
    fireEvent.click(marker);
    fireEvent.keyDown(marker, { key: 'Enter' });
    fireEvent.keyDown(marker, { key: 'a' });
    expect(onPickMark).toHaveBeenCalledTimes(2);
  });

  it('counts the notes of a busy date, and draws the line only while hovered', () => {
    const busy: AnnotationMark = { label: 'Nov 2', annotations: [annotation(), annotation({ id: 'wpan_2' })] };
    const [line] = annotationMarkLines({ marks: [busy], hoveredMark: busy, setHovered: vi.fn() }) as Line[];
    expect(line!.props.stroke).toBe('var(--muted-foreground)');
    badge({ marks: [busy], setHovered: vi.fn() }, { x: 0, y: 0, height: 100 });
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('draws nothing before the chart has laid out', () => {
    const { container } = badge({ marks: [mark], setHovered: vi.fn() });
    expect(container.querySelector('g')).toBeNull();
  });

  it('turns a click on the chart into the row clicked, ignoring clicks off the data', () => {
    expect(annotationChartClick(NO_CHART_ANNOTATIONS, ROWS)).toBeUndefined();
    const onPickIndex = vi.fn();
    const click = annotationChartClick({ ...NO_CHART_ANNOTATIONS, onPickIndex }, ROWS)!;
    click({ activeTooltipIndex: '1' } as never);
    click({ activeTooltipIndex: '7' } as never);
    click({ activeTooltipIndex: null } as never);
    expect(onPickIndex.mock.calls).toEqual([[1]]);
  });

  it("hides the chart's own tooltip while a marker's card shows", () => {
    expect(annotationTooltipActive(NO_CHART_ANNOTATIONS)).toBeUndefined();
    expect(annotationTooltipActive({ ...NO_CHART_ANNOTATIONS, hoveredMark: mark })).toBe(false);
  });
});
