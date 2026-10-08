import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_REPORT_PARAMS } from './report-model';

const dimensions = vi.hoisted(() => ({
  class: [] as Array<{ id: string; name: string }>,
  location: [] as Array<{ id: string; name: string }>,
  calls: [] as Array<{ filters: { dimension?: string }; options: { enabled?: boolean } | undefined }>,
}));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useDimensionValues: (filters: { dimension: 'class' | 'location' }, options?: { enabled?: boolean }) => {
    dimensions.calls.push({ filters, options });
    return { data: options?.enabled === false ? undefined : dimensions[filters.dimension] };
  },
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import { ReportToolbar } from './report-toolbar';

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

function setup(props: Partial<Parameters<typeof ReportToolbar>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <ReportToolbar
      dates="period"
      params={EMPTY_REPORT_PARAMS}
      onChange={onChange}
      defaults={{ from: '2026-01-01', to: '2026-12-31', basis: 'cash' }}
      {...props}
    />,
  );
  return { onChange, ...view };
}

describe('ReportToolbar', () => {
  beforeEach(() => {
    dimensions.class = [];
    dimensions.location = [];
    dimensions.calls = [];
  });

  it('shows the period the server answered with and sends only what the user changes', () => {
    const { onChange } = setup();
    expect(screen.getByLabelText('From')).toHaveValue('2026-01-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-12-31');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-04-01' } });
    expect(onChange).toHaveBeenCalledWith({ from: '2026-04-01' });
  });

  it('shows a single date for a point-in-time report and none when the report has no dates', () => {
    const { rerender } = setup({ dates: 'asOf', defaults: { asOf: '2026-12-31' } });
    expect(screen.getByLabelText('As of')).toHaveValue('2026-12-31');
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();

    rerender(<ReportToolbar dates="none" params={EMPTY_REPORT_PARAMS} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('As of')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
  });

  it('starts on the entity accounting method and switches between accrual and cash', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    expect(screen.getByRole('radio', { name: 'Cash' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Accrual' }));
    expect(onChange).toHaveBeenCalledWith({ basis: 'accrual' });
  });

  it('prefers the basis the user chose over the default', () => {
    setup({ params: { ...EMPTY_REPORT_PARAMS, basis: 'accrual' } });
    expect(screen.getByRole('radio', { name: 'Accrual' })).toBeChecked();
  });

  it('leaves the basis out for reports it does not apply to', () => {
    setup({ showBasis: false });
    expect(screen.queryByRole('radio', { name: 'Cash' })).not.toBeInTheDocument();
  });

  it('chooses a comparison', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Compare' }));
    await user.click(await screen.findByRole('option', { name: 'Previous year' }));
    expect(onChange).toHaveBeenCalledWith({ compare: 'prior_year' });
  });

  it('clears the comparison with the no comparison option', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ params: { ...EMPTY_REPORT_PARAMS, compare: 'prior_period' } });
    await user.click(screen.getByRole('combobox', { name: 'Compare' }));
    await user.click(await screen.findByRole('option', { name: 'No comparison' }));
    expect(onChange).toHaveBeenCalledWith({ compare: '' });
  });

  it('offers month and quarter columns only when asked and locks them while comparing', async () => {
    const user = userEvent.setup();
    const { onChange, rerender } = setup({ showPeriods: true });
    await user.click(screen.getByRole('combobox', { name: 'Columns' }));
    await user.click(await screen.findByRole('option', { name: 'By quarter' }));
    expect(onChange).toHaveBeenCalledWith({ periods: 'quarters' });

    rerender(
      <ReportToolbar
        dates="period"
        params={{ ...EMPTY_REPORT_PARAMS, compare: 'prior_year' }}
        onChange={onChange}
        showPeriods
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Columns' })).toBeDisabled();

    rerender(
      <ReportToolbar
        dates="period"
        params={{ ...EMPTY_REPORT_PARAMS, periods: 'months' }}
        onChange={onChange}
        showPeriods
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Compare' })).toBeDisabled();
  });

  it('has no month columns by default', () => {
    setup();
    expect(screen.queryByRole('combobox', { name: 'Columns' })).not.toBeInTheDocument();
  });

  it('hides the class and location filters while the entity has no such values', () => {
    setup();
    expect(screen.queryByRole('combobox', { name: 'Class' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Location' })).not.toBeInTheDocument();
  });

  it('shows the filters of the dimensions that have values', async () => {
    const user = userEvent.setup();
    dimensions.class = [
      { id: 'dim_a', name: 'Retail' },
      { id: 'dim_b', name: 'Wholesale' },
    ];
    const { onChange } = setup();

    expect(screen.queryByRole('combobox', { name: 'Location' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Class' }));
    expect(await screen.findByRole('option', { name: 'All classes' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Wholesale' }));
    expect(onChange).toHaveBeenCalledWith({ classId: 'dim_b' });
  });

  it('asks only for active values and not at all when the report has no dimensions', () => {
    setup();
    expect(dimensions.calls.every((call) => (call.filters as { isActive?: boolean }).isActive === true)).toBe(true);

    dimensions.calls = [];
    setup({ showDimensions: false });
    expect(dimensions.calls.every((call) => call.options?.enabled === false)).toBe(true);
  });

  it('exports to CSV or PDF from the export menu', async () => {
    const user = userEvent.setup();
    const onCsv = vi.fn();
    const onPdf = vi.fn();
    setup({ exportControls: { onCsv, onPdf, busy: null } });

    await user.click(screen.getByRole('button', { name: /Export/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Download CSV' }));
    expect(onCsv).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Export/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Download PDF' }));
    expect(onPdf).toHaveBeenCalledTimes(1);
  });

  it('disables the export while one runs or the report is missing', () => {
    const { rerender } = setup({ exportControls: { onCsv: vi.fn(), onPdf: vi.fn(), busy: 'pdf' } });
    expect(screen.getByRole('button', { name: /Exporting/ })).toBeDisabled();

    rerender(
      <ReportToolbar
        dates="period"
        params={EMPTY_REPORT_PARAMS}
        onChange={vi.fn()}
        exportControls={{ onCsv: vi.fn(), onPdf: vi.fn(), busy: null, disabled: true }}
      />,
    );
    expect(screen.getByRole('button', { name: /Export/ })).toBeDisabled();
  });

  it('says when it is refreshing the report', () => {
    setup({ isFetching: true });
    expect(screen.getByRole('status')).toHaveTextContent('Updating…');
  });

  it('puts extra controls in front of the others', () => {
    setup({ children: <div data-testid="extra" /> });
    const group = screen.getByRole('group', { name: 'Report options' });
    expect(group.firstElementChild).toBe(screen.getByTestId('extra'));
  });
});

