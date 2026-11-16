import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelFunnelSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { makeFunnelResult } from '../../analytics-fixtures';
import { FunnelResultView } from './funnel-result';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const tf = en.weldpanel.analytics.funnels;

function specWith(steps: number): PanelFunnelSpec {
  return {
    kind: 'funnel',
    projectId: 'wpp_1',
    dateRange: { preset: '30d' },
    steps: Array.from({ length: steps }, (_, i) => ({ event: i === 0 ? '$pageview' : `Step ${i}` })),
  } as unknown as PanelFunnelSpec;
}

describe('FunnelResultView watch links', () => {
  it('links to recordings when the spec and the result have the same steps', () => {
    render(<FunnelResultView result={makeFunnelResult()} spec={specWith(2)} projectId="wpp_1" canWatch />);
    expect(screen.getAllByRole('link', { name: tf.watch.completed }).length).toBeGreaterThan(0);
  });

  it('shows no links, and does not throw, while the result has more steps than the spec', () => {
    const base = makeFunnelResult();
    const third = { ...base.steps[1]!, index: 2, event: 'Paid', label: 'Paid' };
    const result = makeFunnelResult({ steps: [...base.steps, third] });
    expect(() => render(<FunnelResultView result={result} spec={specWith(2)} projectId="wpp_1" canWatch />)).not.toThrow();
    expect(screen.queryByRole('link', { name: tf.watch.completed })).toBeNull();
    expect(screen.queryByRole('link', { name: tf.watch.droppedAt })).toBeNull();
  });
});
