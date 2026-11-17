import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { PanelTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { makeTrendsResult } from '../analytics-fixtures';
import { makeExplainResult } from '../explore-fixtures';
import { ExplainPanel, explainSpec } from './explain-panel';

const state = vi.hoisted(() => ({
  explain: { data: undefined as unknown, error: null as unknown, isPending: false, mutate: vi.fn(), reset: vi.fn() },
  narrate: { data: undefined as unknown, error: null as unknown, isPending: false, mutate: vi.fn(), reset: vi.fn() },
  call: 0,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@/hooks/queries/use-weldpanel-analysis-queries', () => ({
  // The panel calls the hook twice per render: the explanation, then the narrative.
  useExplainWeldPanelChange: () => {
    state.call += 1;
    return state.call % 2 === 1 ? state.explain : state.narrate;
  },
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const tx = en.weldpanel.explore.explain;

const spec: PanelTrendsSpec = {
  kind: 'trends',
  projectId: 'wpp_1',
  series: [
    { event: 'Signed up', math: 'total', filters: [] },
    { event: 'Paid', math: 'avg', property: 'amount', filters: [] },
  ],
  breakdowns: [{ source: 'column', field: 'country' }],
  formulas: [{ expression: 'A / B' }],
  display: 'cumulative',
  compare: true,
};

function renderPanel(aiEnabled = true, initialSeries = 0) {
  return render(
    <ExplainPanel open onOpenChange={vi.fn()} projectId="wpp_1" spec={spec} result={makeTrendsResult()} seriesLabels={['Signed up', 'Paid']} aiEnabled={aiEnabled} initialSeries={initialSeries} />,
  );
}

beforeEach(() => {
  state.call = 0;
  state.explain = { data: undefined, error: null, isPending: false, mutate: vi.fn(), reset: vi.fn() };
  state.narrate = { data: undefined, error: null, isPending: false, mutate: vi.fn(), reset: vi.fn() };
});

describe('ExplainPanel', () => {
  it('sends one series without breakdowns, formulas or drawing options', () => {
    expect(explainSpec(spec, 0)).toMatchObject({ series: [spec.series[0]], compare: false });
    expect(explainSpec(spec, 0).breakdowns).toBeUndefined();
    expect(explainSpec(spec, 0).formulas).toBeUndefined();
    expect(explainSpec(spec, 0).display).toBeUndefined();
  });

  it('explains the range against the period before', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: tx.run }));
    expect(state.explain.mutate).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'wpp_1', narrate: false, spec: expect.objectContaining({ series: [spec.series[0]] }) }));
    expect(state.explain.mutate.mock.calls[0]?.[0]).not.toHaveProperty('bucket');
  });

  it('shows the dimensions that explain the change, and writes a summary on request', async () => {
    state.explain.data = makeExplainResult();
    renderPanel();
    expect(screen.getByText('Country')).toBeTruthy();
    expect(screen.getByText('Netherlands')).toBeTruthy();
    expect(screen.getByText(tx.ai.creditsNote)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: tx.ai.generate }));
    expect(state.narrate.mutate).toHaveBeenCalledWith(expect.objectContaining({ narrate: true, regenerate: false }));
  });

  it('shows the narrative with what it cost', () => {
    state.explain.data = makeExplainResult();
    state.narrate.data = makeExplainResult({ narrative: { text: 'Most of the growth came from the Netherlands.', modelId: 'x', creditsCharged: 3, cached: false } });
    renderPanel();
    expect(screen.getByText('Most of the growth came from the Netherlands.')).toBeTruthy();
    expect(screen.getByText('3 credits used')).toBeTruthy();
  });

  it('says plainly when the wallet is empty', () => {
    state.explain.data = makeExplainResult();
    state.narrate.error = new ApiError('no credits', 402);
    renderPanel();
    expect(screen.getByText(tx.ai.noCreditsGeneric)).toBeTruthy();
  });

  it('leaves the AI summary out when the project has AI turned off', () => {
    state.explain.data = makeExplainResult();
    renderPanel(false);
    expect(screen.queryByRole('button', { name: tx.ai.generate })).toBeNull();
  });

  it('refuses a series that is not a count or a sum', () => {
    renderPanel(true, 1);
    expect(screen.getByText(tx.notExplainable)).toBeTruthy();
    expect(screen.queryByRole('button', { name: tx.run })).toBeNull();
  });
});
