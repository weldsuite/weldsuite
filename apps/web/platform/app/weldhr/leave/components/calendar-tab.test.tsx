import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { CalendarTab } from './calendar-tab';

vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrLeaveRequests: () => ({ data: [], isLoading: false, error: null }),
}));

describe('CalendarTab', () => {
  it('labels the Monday-first columns Monday to Sunday', () => {
    render(
      <I18nProvider initialLanguage="en">
        <CalendarTab />
      </I18nProvider>,
    );
    const expected = Array.from({ length: 7 }, (_, i) =>
      // 5–11 October 2026 runs Monday to Sunday.
      new Date(2026, 9, 5 + i).toLocaleDateString(undefined, { weekday: 'short' }),
    );
    const headers = expected.map((label) => screen.getAllByText(label)[0]!);
    // In document order, first column first.
    for (let i = 1; i < headers.length; i++) {
      expect(headers[i - 1]!.compareDocumentPosition(headers[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(headers[0]!.parentElement!.firstElementChild).toBe(headers[0]);
  });
});
