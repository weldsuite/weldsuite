import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelAlertDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { PanelTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { makeReport } from '../analytics-fixtures';
import { eventAlertSpec } from '../lib/alerts';
import { AlertFormDialog } from './alert-form-dialog';

interface TrendsState {
  data: { result: { interval: 'day' | 'hour'; series: { points: { bucket: string; value: number }[] }[] } } | undefined;
  isLoading: boolean;
  isError: boolean;
}

const state = vi.hoisted(() => ({
  reports: [] as unknown[] | undefined,
  reportsLoading: false,
  trends: { data: undefined, isLoading: false, isError: false } as TrendsState,
  trendCalls: [] as { spec: unknown; options: { enabled?: boolean } }[],
  create: vi.fn(),
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('../components/use-members', () => ({ useMembers: () => ({ members: [], isLoading: false, me: 'user_1', nameOf: () => 'Someone' }) }));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => ({ isInstalled: false, isLoading: false }) }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({ useChannels: () => ({ data: undefined }) }));
// The chart itself has its own tests; here it shows what the form hands it.
vi.mock('../components/charts/time-series-chart', () => ({
  TimeSeriesChart: ({ data, guides }: { data: unknown[]; guides?: { value: number; label: string }[] }) => (
    <figure aria-label="preview chart">
      <span>{`${data.length} points`}</span>
      {(guides ?? []).map((guide) => (
        <span key={guide.label}>{`${guide.label}: ${guide.value}`}</span>
      ))}
    </figure>
  ),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', async () => {
  const { makeLexicon: lexicon } = await import('../analytics-fixtures');
  return {
    useWeldPanelReports: () => ({ data: state.reports, isLoading: state.reportsLoading }),
    useWeldPanelLexicon: () => ({ data: lexicon() }),
    useWeldPanelTrends: (spec: unknown, options: { enabled?: boolean }) => {
      state.trendCalls.push({ spec, options });
      return state.trends;
    },
  };
});
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useCreateWeldPanelAlert: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateWeldPanelAlert: () => ({ mutateAsync: state.update, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const ta = en.weldpanel.collab.alerts;
const tf = ta.form;
const tch = en.weldpanel.collab.channels;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const inAppOnly = { emailUserIds: [], inApp: true, weldchatChannelId: null };

const twoSeries = makeReport({
  id: 'wpr_2',
  name: 'Signups and payments',
  spec: {
    kind: 'trends',
    series: [
      { event: 'Signed up', math: 'total', filters: [] },
      { event: 'Paid', label: 'Payments', math: 'total', filters: [] },
    ],
    interval: 'day',
    filters: [],
    compare: false,
    dateRange: { preset: '30d' },
    timezone: 'UTC',
  },
});

function alert(overrides: Partial<PanelAlertDto> = {}): PanelAlertDto {
  return {
    id: 'pnal_1',
    projectId: 'wpp_1',
    name: 'Signups dropped',
    reportId: 'wpr_1',
    spec: null,
    seriesIndex: 0,
    condition: { type: 'threshold', operator: 'below', value: 100 },
    checkInterval: 'daily',
    channels: { emailUserIds: ['user_1'], inApp: true, slack: false, weldchatChannelId: null },
    enabled: true,
    state: 'ok',
    lastValue: 120,
    lastCheckedAt: null,
    lastFiredAt: null,
    lastError: null,
    snoozedUntil: null,
    nextCheckAt: null,
    ownerUserId: 'user_1',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

const customAlert = () =>
  alert({
    reportId: null,
    spec: eventAlertSpec('wpp_1', 'Signed up', 'unique_users', 'UTC'),
    condition: { type: 'change', direction: 'increase', percent: 25 },
    checkInterval: 'weekly',
  });

function points(values: number[]) {
  return values.map((value, i) => ({ bucket: `2026-11-${String(i + 1).padStart(2, '0')}`, value }));
}

async function choose(label: string, option: string) {
  await userEvent.click(screen.getByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

const submit = (name: string = tf.create) => userEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
  state.reports = [makeReport(), twoSeries];
  state.reportsLoading = false;
  state.trends = { data: undefined, isLoading: false, isError: false };
  state.trendCalls = [];
  for (const fn of [state.create, state.update, state.toast.success, state.toast.error]) fn.mockReset();
});

describe('AlertFormDialog: a new alert', () => {
  it('creates an alert on the report it was opened from', async () => {
    const saved = alert();
    state.create.mockResolvedValue(saved);
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    render(<AlertFormDialog open onOpenChange={onOpenChange} projectId="wpp_1" reportId="wpr_1" onSaved={onSaved} />);
    expect(screen.getByRole('dialog', { name: tf.createTitle })).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: tf.nameLabel }), '  Signups dropped  ');
    await userEvent.type(screen.getByRole('spinbutton', { name: tf.valueLabel }), '50');
    await userEvent.click(screen.getByRole('switch', { name: tch.inAppLabel }));
    await submit();
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toEqual({
      projectId: 'wpp_1',
      name: 'Signups dropped',
      reportId: 'wpr_1',
      seriesIndex: 0,
      condition: { type: 'threshold', operator: 'below', value: 50 },
      checkInterval: 'daily',
      channels: inAppOnly,
      enabled: true,
    });
    expect(state.toast.success).toHaveBeenCalledWith(tf.created);
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says what is missing and sends nothing', async () => {
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" />);
    await submit();
    expect(await screen.findByText(tf.nameRequired)).toBeTruthy();
    expect(screen.getByText(tf.targetRequired)).toBeTruthy();
    expect(screen.getByText(tf.valueRequired)).toBeTruthy();
    expect(screen.getByText(tch.noneChosen)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('asks for a way to send it once the rest is valid', async () => {
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" reportId="wpr_1" />);
    await userEvent.type(screen.getByRole('textbox', { name: tf.nameLabel }), 'Drop');
    await userEvent.type(screen.getByRole('spinbutton', { name: tf.valueLabel }), '5');
    await submit();
    expect(await screen.findByText(tch.noneChosen)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('watches the chosen series of a report with several, checked hourly, switched off', async () => {
    state.create.mockResolvedValue(alert());
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" />);
    await userEvent.type(screen.getByRole('textbox', { name: tf.nameLabel }), 'Payments');
    await choose(tf.reportLabel, 'Signups and payments');
    await choose(tf.seriesLabel, 'B · Payments');
    await choose(tf.operatorLabel, tf.operators.above);
    await userEvent.type(screen.getByRole('spinbutton', { name: tf.valueLabel }), '1.5');
    await choose(tf.intervalLabel, ta.intervals.hourly);
    await userEvent.click(screen.getByRole('switch', { name: tf.enabledLabel }));
    await userEvent.click(screen.getByRole('switch', { name: tch.inAppLabel }));
    await submit();
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({
      reportId: 'wpr_2',
      seriesIndex: 1,
      condition: { type: 'threshold', operator: 'above', value: 1.5 },
      checkInterval: 'hourly',
      enabled: false,
    });
    const lastSpec = state.trendCalls.at(-1)?.spec as PanelTrendsSpec;
    expect(lastSpec).toMatchObject({ projectId: 'wpp_1', interval: 'hour', dateRange: { preset: '7d' }, series: [{ event: 'Paid', label: 'Payments' }] });
  });

  it('watches an event of its own when it changes fast', async () => {
    state.create.mockResolvedValue(alert());
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" />);
    await userEvent.type(screen.getByRole('textbox', { name: tf.nameLabel }), 'Unique signups');
    await choose(tf.sourceLabel, tf.sources.custom);
    const options = Array.from(document.querySelectorAll('#weldpanel-alert-events option')).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['Signed up', 'Upgraded']);
    await userEvent.type(screen.getByRole('combobox', { name: tf.eventLabel }), ' Signed up ');
    await choose(tf.mathLabel, tf.maths.unique_users);
    await choose(tf.conditionLabel, tf.conditionTypes.change);
    await choose(tf.directionLabel, tf.directions.any);
    const percent = screen.getByRole('spinbutton', { name: tf.percentLabel });
    await userEvent.clear(percent);
    await userEvent.type(percent, '0');
    await userEvent.click(screen.getByRole('switch', { name: tch.inAppLabel }));
    await submit();
    expect(await screen.findByText(tf.percentRequired)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
    await userEvent.clear(percent);
    await userEvent.type(percent, '15');
    await submit();
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toEqual({
      projectId: 'wpp_1',
      name: 'Unique signups',
      spec: eventAlertSpec('wpp_1', 'Signed up', 'unique_users', tz),
      seriesIndex: 0,
      condition: { type: 'change', direction: 'any', percent: 15 },
      checkInterval: 'daily',
      channels: inAppOnly,
      enabled: true,
    });
  });

  it('needs an event when it watches one of its own', async () => {
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" />);
    await choose(tf.sourceLabel, tf.sources.custom);
    await submit();
    expect(await screen.findByText(tf.targetRequired)).toBeTruthy();
  });

  it('fires on unusual values at the chosen sensitivity', async () => {
    state.create.mockResolvedValue(alert());
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" reportId="wpr_1" />);
    await userEvent.type(screen.getByRole('textbox', { name: tf.nameLabel }), 'Odd signups');
    await choose(tf.conditionLabel, tf.conditionTypes.anomaly);
    expect(screen.queryByRole('spinbutton', { name: tf.valueLabel })).toBeNull();
    expect(screen.getByText(tf.anomalyHint)).toBeTruthy();
    await choose(tf.sensitivityLabel, tf.sensitivities.high);
    await userEvent.click(screen.getByRole('switch', { name: tch.inAppLabel }));
    await submit();
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0].condition).toEqual({ type: 'anomaly', sensitivity: 'high' });
  });

  it('tells the user when saving fails and stays open', async () => {
    state.create.mockRejectedValue(new Error('boom'));
    const onOpenChange = vi.fn();
    render(<AlertFormDialog open onOpenChange={onOpenChange} projectId="wpp_1" reportId="wpr_1" />);
    await userEvent.type(screen.getByRole('textbox', { name: tf.nameLabel }), 'Drop');
    await userEvent.type(screen.getByRole('spinbutton', { name: tf.valueLabel }), '5');
    await userEvent.click(screen.getByRole('switch', { name: tch.inAppLabel }));
    await submit();
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith(tf.failed));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('closes on cancel and on Escape', async () => {
    const onOpenChange = vi.fn();
    render(<AlertFormDialog open onOpenChange={onOpenChange} projectId="wpp_1" />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.common.cancel }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says when the project has no saved insights, and shows a placeholder while they load', () => {
    state.reports = [];
    const { unmount } = render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" />);
    expect(screen.getByText(tf.noReports)).toBeTruthy();
    unmount();
    state.reports = undefined;
    state.reportsLoading = true;
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" />);
    expect(screen.queryByText(tf.noReports)).toBeNull();
    expect(screen.queryByRole('combobox', { name: tf.reportLabel })).toBeNull();
  });
});

describe('AlertFormDialog: the preview', () => {
  it('waits for something to watch', () => {
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" />);
    expect(screen.getByText(tf.previewEmpty)).toBeTruthy();
    expect(state.trendCalls.at(-1)?.options.enabled).toBe(false);
  });

  it('runs the watched series at the check interval and draws the threshold', async () => {
    state.trends = { data: { result: { interval: 'day', series: [{ points: points([3, 4, 5]) }] } }, isLoading: false, isError: false };
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" reportId="wpr_1" />);
    await userEvent.type(screen.getByRole('spinbutton', { name: tf.valueLabel }), '4');
    expect(screen.getByText('3 points')).toBeTruthy();
    expect(screen.getByText(`${tf.threshold}: 4`)).toBeTruthy();
    const last = state.trendCalls.at(-1)!;
    expect(last.options.enabled).toBe(true);
    expect(last.spec).toMatchObject({ projectId: 'wpp_1', interval: 'day', dateRange: { preset: '90d' }, compare: false });
  });

  it('draws the usual range of an anomaly check', async () => {
    state.trends = { data: { result: { interval: 'day', series: [{ points: points([10, 12, 11, 13, 10, 12, 11, 13, 10, 12]) }] } }, isLoading: false, isError: false };
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" reportId="wpr_1" />);
    await choose(tf.conditionLabel, tf.conditionTypes.anomaly);
    expect(screen.getByText(/^Usual range: /)).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${tf.bandUpper}: `))).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${tf.bandLower}: `))).toBeTruthy();
  });

  it('says when there is too little history for an anomaly check', async () => {
    state.trends = { data: { result: { interval: 'day', series: [{ points: points([1, 2]) }] } }, isLoading: false, isError: false };
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" reportId="wpr_1" />);
    await choose(tf.conditionLabel, tf.conditionTypes.anomaly);
    expect(screen.getByText(tf.previewNoBand)).toBeTruthy();
  });

  it('shows a failed preview, and no chart while loading', () => {
    state.trends = { data: undefined, isLoading: false, isError: true };
    const { unmount } = render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" reportId="wpr_1" />);
    expect(screen.getByText(tf.previewFailed)).toBeTruthy();
    unmount();
    state.trends = { data: undefined, isLoading: true, isError: false };
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" reportId="wpr_1" />);
    expect(screen.queryByRole('figure', { name: 'preview chart' })).toBeNull();
    expect(screen.queryByText(tf.previewFailed)).toBeNull();
  });
});

describe('AlertFormDialog: editing', () => {
  it('fills in the alert and saves without touching what it watches', async () => {
    state.update.mockResolvedValue(alert({ name: 'Renamed' }));
    const onOpenChange = vi.fn();
    render(<AlertFormDialog open onOpenChange={onOpenChange} projectId="wpp_1" alert={alert()} />);
    expect(screen.getByRole('dialog', { name: tf.editTitle })).toBeTruthy();
    const name = screen.getByRole('textbox', { name: tf.nameLabel }) as HTMLInputElement;
    expect(name.value).toBe('Signups dropped');
    expect((screen.getByRole('spinbutton', { name: tf.valueLabel }) as HTMLInputElement).value).toBe('100');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await submit(tf.save);
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0]).toEqual({
      id: 'pnal_1',
      name: 'Renamed',
      seriesIndex: 0,
      condition: { type: 'threshold', operator: 'below', value: 100 },
      checkInterval: 'daily',
      channels: { emailUserIds: ['user_1'], inApp: true, weldchatChannelId: null },
      enabled: true,
    });
    expect(state.toast.success).toHaveBeenCalledWith(tf.saved);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends the new report when the alert moves to another one', async () => {
    state.update.mockResolvedValue(alert());
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" alert={alert()} />);
    await choose(tf.reportLabel, 'Signups and payments');
    await submit(tf.save);
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0]).toMatchObject({ id: 'pnal_1', reportId: 'wpr_2', seriesIndex: 0 });
  });

  it('keeps the own spec of an event alert unless the event or measure changes', async () => {
    state.update.mockResolvedValue(customAlert());
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" alert={customAlert()} />);
    expect((screen.getByRole('combobox', { name: tf.eventLabel }) as HTMLInputElement).value).toBe('Signed up');
    expect(screen.getByRole('combobox', { name: tf.mathLabel }).textContent).toBe(tf.maths.unique_users);
    expect((screen.getByRole('spinbutton', { name: tf.percentLabel }) as HTMLInputElement).value).toBe('25');
    await submit(tf.save);
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    const first = state.update.mock.calls[0]?.[0];
    expect(first).not.toHaveProperty('spec');
    expect(first).toMatchObject({ condition: { type: 'change', direction: 'increase', percent: 25 }, checkInterval: 'weekly' });

    await choose(tf.mathLabel, tf.maths.total);
    await submit(tf.save);
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.update.mock.calls[1]?.[0].spec).toEqual(eventAlertSpec('wpp_1', 'Signed up', 'total', tz));
  });

  it('switches a report alert to an event of its own', async () => {
    state.update.mockResolvedValue(alert());
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" alert={alert({ condition: { type: 'anomaly', sensitivity: 'low' } })} />);
    await choose(tf.sourceLabel, tf.sources.custom);
    await userEvent.type(screen.getByRole('combobox', { name: tf.eventLabel }), 'Upgraded');
    await submit(tf.save);
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0]).toMatchObject({
      spec: eventAlertSpec('wpp_1', 'Upgraded', 'total', tz),
      condition: { type: 'anomaly', sensitivity: 'low' },
    });
  });

  it('switches an event alert to a saved insight', async () => {
    state.update.mockResolvedValue(alert());
    render(<AlertFormDialog open onOpenChange={vi.fn()} projectId="wpp_1" alert={customAlert()} />);
    await choose(tf.sourceLabel, tf.sources.report);
    await choose(tf.reportLabel, 'Weekly signups');
    await submit(tf.save);
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0]).toMatchObject({ reportId: 'wpr_1' });
    expect(state.update.mock.calls[0]?.[0]).not.toHaveProperty('spec');
  });
});
