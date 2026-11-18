import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { PanelSessionsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { SetSummaryDialog } from './set-summary-dialog';

const state = vi.hoisted(() => ({ reset: vi.fn() }));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@/lib/router', () => ({ Link: ({ children }: { children: never }) => <a href="/">{children}</a> }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useSummariseWeldPanelSet: () => ({ data: undefined, error: null, isPending: false, mutate: vi.fn(), reset: state.reset }),
}));

const spec = { kind: 'sessions' } as unknown as PanelSessionsSpec;

describe('SetSummaryDialog', () => {
  it('forgets the last result whenever it closes, however it was closed', () => {
    const { rerender } = render(<SetSummaryDialog projectId="wpp_1" spec={spec} open onOpenChange={vi.fn()} />);
    state.reset.mockClear();
    rerender(<SetSummaryDialog projectId="wpp_1" spec={spec} open={false} onOpenChange={vi.fn()} />);
    expect(state.reset).toHaveBeenCalled();
  });
});
