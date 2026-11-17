import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { PanelPublicShareError } from '@weldsuite/app-api-client/domains/weldpanel-collab';
import type { PanelPublicShareDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import PanelSharePage from './page';

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  share: undefined as unknown,
  error: null as unknown,
  isLoading: false,
  framed: false,
  resultCalls: [] as { token: string; input: unknown }[],
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ token: 'wpsh_token' }),
  useSearch: () => state.search,
}));
vi.mock('./framing', () => ({ isFramed: () => state.framed }));
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useWeldPanelPublicShare: () => ({ data: state.share, error: state.error, isLoading: state.isLoading }),
  useWeldPanelPublicResult: (token: string, input: unknown) => {
    state.resultCalls.push({ token, input });
    return { data: { kind: 'trends', result: {}, dataAsOf: '2026-11-01T00:00:00Z', cached: false }, isLoading: false, isError: false, refetch: vi.fn() };
  },
}));
vi.mock('@/app/weldpanel/components/report-view', () => ({
  ReportResultBody: ({ data }: { data: { kind: string } }) => <div data-testid="result">{data.kind} result</div>,
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

const tp = en.weldpanel.collab.publicPage;

function share(overrides: Partial<PanelPublicShareDto> = {}): PanelPublicShareDto {
  return {
    targetType: 'report',
    name: 'Weekly traffic',
    description: 'Visitors per week',
    projectName: 'Acme site',
    allowEmbed: false,
    allowDateChange: false,
    datePresets: [],
    expiresAt: null,
    report: { name: 'Weekly traffic', description: null, kind: 'trends', spec: { kind: 'trends', dateRange: { preset: '30d' } } },
    tiles: [],
    ...overrides,
  };
}

describe('Public share page', () => {
  beforeEach(() => {
    state.search = {};
    state.share = share();
    state.error = null;
    state.isLoading = false;
    state.framed = false;
    state.resultCalls = [];
  });
  afterEach(() => {
    document.head.querySelectorAll('meta[name="robots"], meta[name="referrer"]').forEach((el) => el.remove());
  });

  it('shows a shared report with its header and footer, out of search engines and referrers', () => {
    render(<PanelSharePage />);
    expect(screen.getByRole('heading', { name: 'Weekly traffic' })).toBeTruthy();
    expect(screen.getByText('Shared from Acme site')).toBeTruthy();
    expect(screen.getByTestId('result').textContent).toBe('trends result');
    expect(screen.getByRole('link', { name: tp.madeWith })).toBeTruthy();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow');
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    expect(state.resultCalls[0]).toEqual({ token: 'wpsh_token', input: {} });
  });

  it('drops the header when embedded', () => {
    state.framed = true;
    state.share = share({ allowEmbed: true });
    state.search = { embed: 1 };
    render(<PanelSharePage />);
    expect(screen.queryByRole('heading', { name: 'Weekly traffic' })).toBeNull();
    expect(screen.getByTestId('result')).toBeTruthy();
  });

  it('shows nothing of the report inside an iframe when the link does not allow embedding', () => {
    state.framed = true;
    render(<PanelSharePage />);
    expect(screen.getByText(tp.embedBlockedTitle)).toBeTruthy();
    expect(screen.queryByTestId('result')).toBeNull();
    expect(state.resultCalls).toHaveLength(0);
  });

  it('lets viewers pick another period when the link allows it', async () => {
    state.share = share({ allowDateChange: true, datePresets: ['7d', '30d', '90d'] });
    render(<PanelSharePage />);
    await userEvent.click(screen.getByRole('combobox', { name: tp.periodLabel }));
    await userEvent.click(await screen.findByRole('option', { name: en.weldpanel.analytics.range['7d'] }));
    await waitFor(() => expect(state.resultCalls[state.resultCalls.length - 1]?.input).toEqual({ dateRange: { preset: '7d' } }));
  });

  it('lays out a dashboard: Markdown text tiles and a result per report tile', () => {
    state.share = share({
      targetType: 'dashboard',
      report: null,
      tiles: [
        { id: 'wpt_text', kind: 'text', layout: { x: 0, y: 0, w: 24, h: 3 }, text: '## About these numbers', report: null },
        { id: 'wpt_1', kind: 'report', layout: { x: 0, y: 3, w: 12, h: 8 }, text: null, report: { name: 'Signups', description: null, kind: 'trends', spec: {} } },
      ],
    });
    render(<PanelSharePage />);
    expect(screen.getByRole('heading', { name: 'About these numbers' })).toBeTruthy();
    expect(screen.getByText('Signups')).toBeTruthy();
    expect(state.resultCalls[0]).toEqual({ token: 'wpsh_token', input: { tileId: 'wpt_1' } });
  });

  it('says the link does not work for an unknown, revoked or expired token', () => {
    state.share = undefined;
    state.error = new PanelPublicShareError('Not found', 404, 'NOT_FOUND');
    render(<PanelSharePage />);
    expect(screen.getByText(tp.notFoundTitle)).toBeTruthy();
  });

  it('asks to wait when rate limited', () => {
    state.share = undefined;
    state.error = new PanelPublicShareError('Slow down', 429, null);
    render(<PanelSharePage />);
    expect(screen.getByText(tp.rateLimitedTitle)).toBeTruthy();
  });
});
