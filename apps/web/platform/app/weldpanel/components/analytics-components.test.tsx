import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelDateRange, PanelFilter, PanelReportSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { makeCohort, makeLexicon, makeReport } from '../analytics-fixtures';
import { DateRangePicker } from './date-range-picker';
import { FilterBuilder } from './filter-builder';
import { FreshnessBadge } from './freshness-badge';
import { QueryErrorState } from './query-error-state';
import { ReportActions } from './report-actions';

const state = vi.hoisted(() => ({
  lexicon: undefined as unknown,
  lexiconError: false,
  cohorts: [] as unknown[],
  dashboards: [] as unknown[],
  allowed: new Set<string>(),
  create: vi.fn(),
  addTile: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.allowed.has(key) }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelLexicon: () => ({ data: state.lexiconError ? undefined : state.lexicon, isError: state.lexiconError }),
  useWeldPanelCohorts: () => ({ data: state.cohorts }),
  useWeldPanelDashboards: () => ({ data: state.dashboards }),
  useCreateWeldPanelReport: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateWeldPanelReport: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddWeldPanelDashboardTile: () => ({ mutateAsync: state.addTile, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

beforeEach(() => {
  state.lexicon = makeLexicon();
  state.lexiconError = false;
  state.cohorts = [makeCohort({ id: 'wpc_1', name: 'Pro users' })];
  state.dashboards = [];
  state.allowed = new Set(['panel_reports:create', 'panel_reports:update']);
  state.create.mockReset();
  state.addTile.mockReset();
});

describe('DateRangePicker', () => {
  function Harness({ initial = { preset: '30d' } as PanelDateRange, onChange = vi.fn() }) {
    const [value, setValue] = useState<PanelDateRange>(initial);
    return (
      <DateRangePicker
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }

  it('shows the current preset and picks another', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByRole('button', { name: /Last 30 days/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Date range/ }));
    await userEvent.click(await screen.findByRole('button', { name: en.weldpanel.analytics.range.today }));
    expect(onChange).toHaveBeenCalledWith({ preset: 'today' });
    expect(screen.getByRole('button', { name: /Today/ })).toBeTruthy();
  });

  it('applies a custom range once both days are valid', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Date range/ }));
    const apply = await screen.findByRole('button', { name: en.weldpanel.analytics.range.apply });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(en.weldpanel.analytics.range.from), '2026-11-01');
    await userEvent.type(screen.getByLabelText(en.weldpanel.analytics.range.to), '2026-11-05');
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(apply);
    expect(onChange).toHaveBeenCalledWith({ from: '2026-11-01', to: '2026-11-05' });
    expect(screen.getByRole('button', { name: /Nov 1, 2026/ })).toBeTruthy();
  });

  it('refuses a start after the end', async () => {
    render(<Harness initial={{ from: '2026-11-10', to: '2026-11-12' }} />);
    await userEvent.click(screen.getByRole('button', { name: /Date range/ }));
    const from = await screen.findByLabelText(en.weldpanel.analytics.range.from);
    await userEvent.clear(from);
    await userEvent.type(from, '2026-11-13');
    expect(await screen.findByText(en.weldpanel.analytics.range.invalid)).toBeTruthy();
    expect((screen.getByRole('button', { name: en.weldpanel.analytics.range.apply }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('FilterBuilder', () => {
  function Harness({ allowCohort = true }: { allowCohort?: boolean }) {
    const [filters, setFilters] = useState<PanelFilter[]>([]);
    return (
      <>
        <FilterBuilder projectId="wpp_1" filters={filters} onChange={setFilters} allowCohort={allowCohort} />
        <output data-testid="filters">{JSON.stringify(filters)}</output>
      </>
    );
  }
  const current = () => JSON.parse(screen.getByTestId('filters').textContent ?? '[]') as PanelFilter[];

  async function openForm() {
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.filters.add }));
    return screen.findByRole('button', { name: en.weldpanel.analytics.filters.apply });
  }

  it('adds a column filter and shows it as a chip that can be removed', async () => {
    render(<Harness />);
    const submit = await openForm();
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(en.weldpanel.analytics.filters.value), '/pricing');
    await userEvent.click(submit);
    expect(current()).toEqual([{ source: 'column', field: 'path', operator: 'eq', value: '/pricing' }]);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.filters.remove.replace('{filter}', 'Page path is /pricing') }));
    expect(current()).toEqual([]);
  });

  it('takes a list for "is one of"', async () => {
    render(<Harness />);
    const submit = await openForm();
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.filters.field }));
    await userEvent.click(await screen.findByRole('option', { name: en.weldpanel.analytics.filters.columns.country }));
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.filters.operator }));
    await userEvent.click(await screen.findByRole('option', { name: en.weldpanel.analytics.filters.operators.in }));
    await userEvent.type(screen.getByLabelText(en.weldpanel.analytics.filters.value), 'NL, DE');
    await userEvent.click(submit);
    expect(current()).toEqual([{ source: 'column', field: 'country', operator: 'in', value: ['NL', 'DE'] }]);
  });

  it('needs no value for "is set"', async () => {
    render(<Harness />);
    const submit = await openForm();
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.filters.operator }));
    await userEvent.click(await screen.findByRole('option', { name: en.weldpanel.analytics.filters.operators.is_set }));
    expect(screen.queryByLabelText(en.weldpanel.analytics.filters.value)).toBeNull();
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('filters on an event property chosen from the lexicon', async () => {
    render(<Harness />);
    const submit = await openForm();
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.filters.source }));
    await userEvent.click(await screen.findByRole('option', { name: en.weldpanel.analytics.filters.sources.event }));
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.filters.property }));
    await userEvent.click(await screen.findByText('plan'));
    await userEvent.type(screen.getByLabelText(en.weldpanel.analytics.filters.value), 'pro');
    await userEvent.click(submit);
    expect(current()).toEqual([{ source: 'event', key: 'plan', operator: 'eq', value: 'pro' }]);
  });

  it('filters on a cohort, or leaves cohorts out where they may not nest', async () => {
    const { unmount } = render(<Harness />);
    const submit = await openForm();
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.filters.source }));
    await userEvent.click(await screen.findByRole('option', { name: en.weldpanel.analytics.filters.sources.cohort }));
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.filters.cohort }));
    await userEvent.click(await screen.findByRole('option', { name: 'Pro users' }));
    await userEvent.click(submit);
    expect(current()).toEqual([{ source: 'cohort', cohortId: 'wpc_1', negate: false }]);
    expect(await screen.findByText('in Pro users')).toBeTruthy();
    unmount();

    render(<Harness allowCohort={false} />);
    await openForm();
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.filters.source }));
    expect(screen.queryByRole('option', { name: en.weldpanel.analytics.filters.sources.cohort })).toBeNull();
  });

  it('clears several filters at once', async () => {
    function Preset() {
      const [filters, setFilters] = useState<PanelFilter[]>([
        { source: 'column', field: 'country', operator: 'eq', value: 'NL' },
        { source: 'column', field: 'path', operator: 'eq', value: '/' },
      ]);
      return <FilterBuilder projectId="wpp_1" filters={filters} onChange={setFilters} />;
    }
    render(<Preset />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.filters.clear }));
    expect(screen.queryByText('Country is NL')).toBeNull();
  });
});

describe('QueryErrorState', () => {
  it('is a calm notice for a 503, not an alert', () => {
    render(<QueryErrorState error={new ApiError('down', 503)} />);
    expect(screen.getByText(en.weldpanel.analytics.errors.notConfiguredTitle)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names a missing permission for a 403', () => {
    render(<QueryErrorState error={new ApiError('no', 403)} />);
    expect(screen.getByText(en.weldpanel.analytics.errors.forbidden)).toBeTruthy();
  });

  it('offers a retry otherwise', async () => {
    const onRetry = vi.fn();
    render(<QueryErrorState error={new Error('boom')} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.errors.retry }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('FreshnessBadge', () => {
  it('shows the time, whether it was cached and a refresh button', async () => {
    const onRefresh = vi.fn();
    render(<FreshnessBadge dataAsOf="2026-11-14T12:30:00.000Z" cached onRefresh={onRefresh} clampedToRetention />);
    expect(screen.getByText(/Data as of/)).toBeTruthy();
    expect(screen.getByText(en.weldpanel.analytics.freshness.cached)).toBeTruthy();
    expect(screen.getByText(en.weldpanel.analytics.freshness.clamped)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.freshness.refresh }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('shows nothing before there is data', () => {
    const { container } = render(<FreshnessBadge dataAsOf={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ReportActions', () => {
  const spec = { kind: 'trends', projectId: 'wpp_1', series: [{ event: 'Signed up' }] } as PanelReportSpec;

  it('disables saving until the analysis is complete', () => {
    render(<ReportActions projectId="wpp_1" spec={null} />);
    expect((screen.getByRole('button', { name: en.weldpanel.analytics.save.saveReport }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers nothing to someone who may not create or update reports', () => {
    state.allowed = new Set();
    render(<ReportActions projectId="wpp_1" spec={spec} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('saves an unsaved analysis as a report first, then puts it on the dashboard', async () => {
    state.dashboards = [{ id: 'wpd_1', name: 'Marketing weekly' }];
    state.create.mockResolvedValue(makeReport({ id: 'wpr_new' }));
    state.addTile.mockResolvedValue(undefined);
    const onSaved = vi.fn();
    render(<ReportActions projectId="wpp_1" spec={spec} defaultName="Signed up" onSaved={onSaved} />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.save.addToDashboard }));
    const dialog = await screen.findByRole('dialog', { name: en.weldpanel.analytics.save.dashboardDialogTitle });
    const add = within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.add }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole('combobox', { name: en.weldpanel.analytics.save.dashboardLabel }));
    await userEvent.click(await screen.findByRole('option', { name: 'Marketing weekly' }));
    await userEvent.click(add);
    await waitFor(() => expect(state.addTile).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({ projectId: 'wpp_1', name: 'Signed up', visibility: 'private' });
    expect(state.addTile.mock.calls[0]?.[0]).toMatchObject({ reportId: 'wpr_new' });
    expect(onSaved).toHaveBeenCalled();
  });

  it('puts an already saved report on the dashboard without saving it again', async () => {
    state.dashboards = [{ id: 'wpd_1', name: 'Marketing weekly' }];
    state.addTile.mockResolvedValue(undefined);
    render(<ReportActions projectId="wpp_1" spec={spec} report={makeReport({ id: 'wpr_1' })} />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.save.addToDashboard }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(en.weldpanel.analytics.save.nameLabel)).toBeNull();
    await userEvent.click(within(dialog).getByRole('combobox', { name: en.weldpanel.analytics.save.dashboardLabel }));
    await userEvent.click(await screen.findByRole('option', { name: 'Marketing weekly' }));
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.add }));
    await waitFor(() => expect(state.addTile).toHaveBeenCalledTimes(1));
    expect(state.create).not.toHaveBeenCalled();
    expect(state.addTile.mock.calls[0]?.[0]).toMatchObject({ reportId: 'wpr_1' });
  });

  it('points to the dashboards when there are none yet', async () => {
    render(<ReportActions projectId="wpp_1" spec={spec} report={makeReport()} />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.save.addToDashboard }));
    expect(await screen.findByText(en.weldpanel.analytics.save.noDashboards, { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: en.weldpanel.analytics.save.newDashboard }).getAttribute('href')).toBe('/weldpanel/dashboards');
  });
});
