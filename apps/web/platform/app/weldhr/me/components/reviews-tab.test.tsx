import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrSelfCoachingLog, HrSelfEvaluation } from '@weldsuite/app-api-client/domains/weldhr';
import type { ActiveFilter, ColumnDef, FilterConfig, GroupConfig } from '@/components/panel-entity-list';

/** The row handlers the real list hands each column; these columns use none of them. */
const ROW_HANDLERS = { onEdit: () => {}, onDelete: () => {}, onDuplicate: () => {}, onUpdate: () => {} };

interface StubProps {
  items: Array<{ id: string }>;
  isLoading: boolean;
  error?: Error | null;
  columns: ColumnDef<{ id: string }>[];
  onRowClick: (row: { id: string }) => void;
  rowMenu?: (row: { id: string }) => ReactNode;
  groups: GroupConfig<{ id: string }>[];
  filters: FilterConfig[];
  applyFilters: (rows: Array<{ id: string }>, active: ActiveFilter[]) => Array<{ id: string }>;
  searchFields: string[];
  searchPlaceholder: string;
  emptyState: { title: string; description: string };
}

type Query<T> = { data: T | undefined; isLoading: boolean; error: Error | null };

const mocks = vi.hoisted(() => ({ open: vi.fn() }));

let evaluationsQuery: Query<HrSelfEvaluation[]>;
let coachingQuery: Query<HrSelfCoachingLog[]>;

vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: mocks.open }) }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrEvaluations: () => evaluationsQuery,
  useMyHrCoaching: () => coachingQuery,
}));
vi.mock('./acknowledge-dialog', () => ({
  AcknowledgeDialog: ({ target, onClose }: { target: { kind: string; id: string }; onClose: () => void }) => (
    <div role="dialog">
      <p>{`acknowledging ${target.kind} ${target.id}`}</p>
      <button type="button" onClick={onClose}>
        Close dialog
      </button>
    </div>
  ),
}));
// A plain stand-in for the list: its groups, filter options, columns and row menu, as the list would use them.
vi.mock('@/components/panel-entity-list', () => ({
  PanelEntityList: (props: StubProps) => <ListStub {...props} />,
}));

function ListStub(props: StubProps) {
  const [active, setActive] = useState<ActiveFilter[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  if (props.isLoading) return <p>loading</p>;
  if (props.error) return <p role="alert">{props.error.message}</p>;
  if (props.items.length === 0) {
    return (
      <div>
        <p>{props.emptyState.title}</p>
        <p>{props.emptyState.description}</p>
      </div>
    );
  }
  const rows = props.applyFilters(props.items, active);
  const toggle = (field: string, value: string) => setActive([{ id: `${field}-${value}`, field, operator: 'is', value }]);
  return (
    <div>
      <input aria-label="search" placeholder={props.searchPlaceholder} data-fields={props.searchFields.join(',')} readOnly />
      <button type="button" onClick={() => setActive([{ id: 'blank', field: 'status', operator: 'is', value: '' }])}>
        blank filter
      </button>
      <button type="button" onClick={() => setActive([{ id: 'x', field: 'unknown', operator: 'is', value: 'x' }])}>
        unknown filter
      </button>
      <button type="button" onClick={() => setActive([])}>
        clear filters
      </button>
      {props.filters.map((filter) => (
        <div key={filter.field} role="group" aria-label={`filter ${filter.field}`}>
          <span>{filter.label}</span>
          {filter.options?.map((option) => (
            <button key={option.value} type="button" onClick={() => toggle(filter.field, option.value)}>
              {`${filter.field}: ${option.label}`}
            </button>
          ))}
        </div>
      ))}
      {[...props.groups]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((group) => {
          const inGroup = rows.filter(group.filter);
          if (inGroup.length === 0) return null;
          return (
            <section key={group.id} aria-label={`group ${group.id}`}>
              <h4>{group.label}</h4>
              {inGroup.map((row) => (
                <div key={row.id} data-testid={`row-${row.id}`}>
                  {props.columns.map((column) => (
                    <div key={column.id} data-column={column.id}>
                      {column.render(row, ROW_HANDLERS)}
                    </div>
                  ))}
                  <button type="button" onClick={() => props.onRowClick(row)}>{`open ${row.id}`}</button>
                  <DropdownMenu open={menuFor === row.id} onOpenChange={(open) => setMenuFor(open ? row.id : null)}>
                    <DropdownMenuTrigger asChild>
                      <button type="button">{`menu ${row.id}`}</button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>{props.rowMenu?.(row)}</DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </section>
          );
        })}
    </div>
  );
}

import {
  AcknowledgeMenuItem,
  MyCoachingList,
  MyEvaluationsList,
  coachingToAcknowledge,
  evaluationPeriod,
  evaluationToAcknowledge,
} from './reviews-tab';

function evaluation(extra: Partial<HrSelfEvaluation> = {}): HrSelfEvaluation {
  return {
    id: 'ev_1',
    formName: 'Q4 review',
    periodStart: '2026-10-01',
    periodEnd: '2026-12-31',
    criteria: [],
    scores: [],
    overallScore: 82.5,
    summary: null,
    status: 'submitted',
    evaluatorName: 'Maria Manager',
    submittedAt: '2026-12-20',
    acknowledgedAt: null,
    employeeComment: null,
    ...extra,
  };
}

function coaching(extra: Partial<HrSelfCoachingLog> = {}): HrSelfCoachingLog {
  return {
    id: 'co_1',
    sessionDate: '2026-11-10',
    category: 'development',
    topic: 'Growing into lead',
    notes: null,
    actionItems: [],
    followUpDate: '2026-12-01',
    status: 'open',
    coachName: 'Carl Coach',
    acknowledgedAt: null,
    employeeComment: null,
    ...extra,
  };
}

function loaded<T>(data: T): Query<T> {
  return { data, isLoading: false, error: null };
}

function renderWithI18n(ui: ReactNode) {
  return render(<I18nProvider initialLanguage="en">{ui}</I18nProvider>);
}

beforeEach(() => {
  mocks.open.mockReset();
  evaluationsQuery = loaded([]);
  coachingQuery = loaded([]);
});

describe('review helpers', () => {
  it('asks to acknowledge only an evaluation shared with you that you have not acknowledged', () => {
    expect(evaluationToAcknowledge(evaluation())).toBe(true);
    expect(evaluationToAcknowledge(evaluation({ status: 'draft' }))).toBe(false);
    expect(evaluationToAcknowledge(evaluation({ acknowledgedAt: '2026-12-22' }))).toBe(false);
  });

  it('asks to acknowledge a coaching session without an acknowledgement', () => {
    expect(coachingToAcknowledge(coaching())).toBe(true);
    expect(coachingToAcknowledge(coaching({ acknowledgedAt: '2026-11-11' }))).toBe(false);
  });

  it('writes the evaluation period, or a dash without one', () => {
    expect(evaluationPeriod(evaluation())).toBe('1 Oct 2026 – 31 Dec 2026');
    expect(evaluationPeriod(evaluation({ periodStart: null }))).toBe('— – 31 Dec 2026');
    expect(evaluationPeriod(evaluation({ periodStart: null, periodEnd: null }))).toBe('—');
  });

  it('calls back when Acknowledge is picked', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import('@weldsuite/ui/components/dropdown-menu');
    renderWithI18n(
      <DropdownMenu>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AcknowledgeMenuItem onSelect={onSelect} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole('button', { name: 'menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Acknowledge' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('MyEvaluationsList', () => {
  beforeEach(() => {
    evaluationsQuery = loaded([
      evaluation(),
      evaluation({ id: 'ev_2', formName: null, evaluatorName: null, overallScore: null, status: 'draft', periodStart: null, periodEnd: null }),
      evaluation({ id: 'ev_3', formName: 'Mid-year', evaluatorName: 'Maria Manager', status: 'acknowledged', acknowledgedAt: '2026-07-02' }),
      evaluation({ id: 'ev_4', formName: 'Probation', evaluatorName: 'Alex Lead', status: 'acknowledged', acknowledgedAt: '2026-03-02' }),
    ]);
  });

  it('groups what is to acknowledge first, then the earlier ones', () => {
    renderWithI18n(<MyEvaluationsList />);

    const toAcknowledge = screen.getByRole('region', { name: 'group toAcknowledge' });
    expect(within(toAcknowledge).getByText('To acknowledge')).toBeInTheDocument();
    expect(within(toAcknowledge).getByTestId('row-ev_1')).toBeInTheDocument();
    const earlier = screen.getByRole('region', { name: 'group earlier' });
    expect(within(earlier).getAllByTestId(/^row-/)).toHaveLength(3);
    expect(screen.getByLabelText('search')).toHaveAttribute('placeholder', 'Search evaluations...');
    expect(screen.getByLabelText('search')).toHaveAttribute('data-fields', 'formName,evaluatorName,summary');
  });

  it('shows each evaluation with its evaluator, period, score and status', () => {
    renderWithI18n(<MyEvaluationsList />);

    const row = screen.getByTestId('row-ev_1');
    const cell = (id: string) => row.querySelector(`[data-column="${id}"]`) as HTMLElement;
    expect(within(cell('evaluation')).getByText('Q4 review')).toBeInTheDocument();
    expect(within(cell('evaluation')).getByText('1 Oct 2026 – 31 Dec 2026')).toBeInTheDocument();
    expect(cell('evaluator')).toHaveTextContent('Maria Manager');
    expect(cell('period')).toHaveTextContent('1 Oct 2026 – 31 Dec 2026');
    expect(cell('score')).toHaveTextContent('82.5');
    expect(cell('status')).toHaveTextContent('Submitted');
  });

  it('shows dashes and the untitled name for what an evaluation lacks', () => {
    renderWithI18n(<MyEvaluationsList />);

    const row = screen.getByTestId('row-ev_2');
    const cell = (id: string) => row.querySelector(`[data-column="${id}"]`) as HTMLElement;
    expect(within(cell('evaluation')).getByText('Evaluation')).toBeInTheDocument();
    expect(cell('evaluator')).toHaveTextContent('—');
    expect(cell('period')).toHaveTextContent('—');
    expect(cell('score')).toHaveTextContent('—');
  });

  it('opens the panel of a row', async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyEvaluationsList />);

    await user.click(screen.getByRole('button', { name: 'open ev_3' }));
    expect(mocks.open).toHaveBeenCalledWith({ type: 'hr_my_evaluation', id: 'ev_3' });
  });

  it('offers Acknowledge in the row menu only where it applies, and opens the dialog', async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyEvaluationsList />);

    await user.click(screen.getByRole('button', { name: 'menu ev_3' }));
    expect(screen.queryByRole('menuitem', { name: 'Acknowledge' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'menu ev_1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Acknowledge' }));
    expect(screen.getByText('acknowledging evaluation ev_1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers the statuses, and the evaluators found in the list, as filters', () => {
    renderWithI18n(<MyEvaluationsList />);

    const status = screen.getByRole('group', { name: 'filter status' });
    expect(within(status).getByRole('button', { name: 'status: Submitted' })).toBeInTheDocument();
    expect(within(status).getByRole('button', { name: 'status: Acknowledged' })).toBeInTheDocument();
    const evaluator = screen.getByRole('group', { name: 'filter evaluator' });
    // Sorted, each once, without the empty one.
    expect(within(evaluator).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'evaluator: Alex Lead',
      'evaluator: Maria Manager',
    ]);
  });

  it('narrows the rows by status and by evaluator, and ignores a blank or unknown filter', async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyEvaluationsList />);

    await user.click(screen.getByRole('button', { name: 'status: Acknowledged' }));
    expect(screen.getAllByTestId(/^row-/).map((r) => r.dataset.testid)).toEqual(['row-ev_3', 'row-ev_4']);

    await user.click(screen.getByRole('button', { name: 'evaluator: Alex Lead' }));
    expect(screen.getAllByTestId(/^row-/).map((r) => r.dataset.testid)).toEqual(['row-ev_4']);

    await user.click(screen.getByRole('button', { name: 'blank filter' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'unknown filter' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(4);
  });

  it('leaves the evaluator filter out when no evaluation names one', () => {
    evaluationsQuery = loaded([evaluation({ evaluatorName: null })]);
    renderWithI18n(<MyEvaluationsList />);
    expect(screen.queryByRole('group', { name: 'filter evaluator' })).not.toBeInTheDocument();
  });

  it('says so when there are none, while loading and when loading failed', () => {
    evaluationsQuery = loaded([]);
    const first = renderWithI18n(<MyEvaluationsList />);
    expect(screen.getByText('No evaluations yet')).toBeInTheDocument();
    first.unmount();

    evaluationsQuery = { data: undefined, isLoading: true, error: null };
    const second = renderWithI18n(<MyEvaluationsList />);
    expect(screen.getByText('loading')).toBeInTheDocument();
    second.unmount();

    evaluationsQuery = { data: undefined, isLoading: false, error: new Error('Down') };
    renderWithI18n(<MyEvaluationsList />);
    expect(screen.getByRole('alert')).toHaveTextContent('Down');
  });
});

describe('MyCoachingList', () => {
  beforeEach(() => {
    coachingQuery = loaded([
      coaching(),
      coaching({
        id: 'co_2',
        topic: '',
        category: 'quality',
        coachName: null,
        followUpDate: null,
        sessionDate: '2026-11-20',
        status: 'acknowledged',
        acknowledgedAt: '2026-11-21',
      }),
      coaching({ id: 'co_3', category: 'quality', coachName: 'Carl Coach', sessionDate: '2026-10-01', status: 'closed', acknowledgedAt: '2026-10-02' }),
    ]);
  });

  it('groups to acknowledge first, and lists sessions newest first', () => {
    renderWithI18n(<MyCoachingList />);

    expect(within(screen.getByRole('region', { name: 'group toAcknowledge' })).getByTestId('row-co_1')).toBeInTheDocument();
    const acknowledged = screen.getByRole('region', { name: 'group acknowledged' });
    expect(within(acknowledged).getAllByTestId(/^row-/).map((r) => r.dataset.testid)).toEqual(['row-co_2', 'row-co_3']);
    expect(screen.getByLabelText('search')).toHaveAttribute('data-fields', 'topic,notes,coachName');
  });

  it('shows each session with its date, category, coach, follow-up and status', () => {
    renderWithI18n(<MyCoachingList />);

    const row = screen.getByTestId('row-co_1');
    const cell = (id: string) => row.querySelector(`[data-column="${id}"]`) as HTMLElement;
    expect(within(cell('topic')).getByText('Growing into lead')).toBeInTheDocument();
    expect(within(cell('topic')).getByText('10 Nov 2026 · Carl Coach')).toBeInTheDocument();
    expect(cell('date')).toHaveTextContent('10 Nov 2026');
    expect(cell('category')).toHaveTextContent('Development');
    expect(cell('coach')).toHaveTextContent('Carl Coach');
    expect(cell('followUp')).toHaveTextContent('1 Dec 2026');
    expect(cell('status')).toHaveTextContent('Open');
  });

  it('falls back to the category as the topic and to dashes', () => {
    renderWithI18n(<MyCoachingList />);

    const row = screen.getByTestId('row-co_2');
    const cell = (id: string) => row.querySelector(`[data-column="${id}"]`) as HTMLElement;
    expect(within(cell('topic')).getByText('Quality')).toBeInTheDocument();
    expect(within(cell('topic')).getByText('20 Nov 2026')).toBeInTheDocument();
    expect(cell('coach')).toHaveTextContent('—');
    expect(cell('followUp')).toHaveTextContent('—');
  });

  it('opens a row and acknowledges from its menu where it applies', async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyCoachingList />);

    await user.click(screen.getByRole('button', { name: 'open co_3' }));
    expect(mocks.open).toHaveBeenCalledWith({ type: 'hr_my_coaching', id: 'co_3' });

    await user.click(screen.getByRole('button', { name: 'menu co_2' }));
    expect(screen.queryByRole('menuitem', { name: 'Acknowledge' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'menu co_1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Acknowledge' }));
    expect(screen.getByText('acknowledging coaching co_1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('filters by category, status and coach, once for each category found', async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyCoachingList />);

    const category = screen.getByRole('group', { name: 'filter category' });
    expect(within(category).getAllByRole('button').map((b) => b.textContent)).toEqual(['category: Quality', 'category: Development']);
    expect(within(screen.getByRole('group', { name: 'filter status' })).getAllByRole('button')).toHaveLength(3);
    expect(within(screen.getByRole('group', { name: 'filter coach' })).getAllByRole('button')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'category: Quality' }));
    expect(screen.getAllByTestId(/^row-/).map((r) => r.dataset.testid)).toEqual(['row-co_2', 'row-co_3']);

    await user.click(screen.getByRole('button', { name: 'status: Closed' }));
    expect(screen.getAllByTestId(/^row-/).map((r) => r.dataset.testid)).toEqual(['row-co_3']);

    await user.click(screen.getByRole('button', { name: 'coach: Carl Coach' }));
    expect(screen.getAllByTestId(/^row-/).map((r) => r.dataset.testid)).toEqual(['row-co_1', 'row-co_3']);

    await user.click(screen.getByRole('button', { name: 'blank filter' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'unknown filter' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(3);
  });

  it('leaves the coach filter out when no session names a coach', () => {
    coachingQuery = loaded([coaching({ coachName: null })]);
    renderWithI18n(<MyCoachingList />);
    expect(screen.queryByRole('group', { name: 'filter coach' })).not.toBeInTheDocument();
  });

  it('says so when there are none, while loading and when loading failed', () => {
    coachingQuery = loaded([]);
    const first = renderWithI18n(<MyCoachingList />);
    expect(screen.getByText('No coaching sessions yet')).toBeInTheDocument();
    first.unmount();

    coachingQuery = { data: undefined, isLoading: true, error: null };
    const second = renderWithI18n(<MyCoachingList />);
    expect(screen.getByText('loading')).toBeInTheDocument();
    second.unmount();

    coachingQuery = { data: undefined, isLoading: false, error: new Error('Down') };
    renderWithI18n(<MyCoachingList />);
    expect(screen.getByRole('alert')).toHaveTextContent('Down');
  });
});
