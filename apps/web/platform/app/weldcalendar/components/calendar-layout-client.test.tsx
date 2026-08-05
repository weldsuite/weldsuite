import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CalendarLayoutClient } from './calendar-layout-client';

vi.mock('./calendar-header', () => ({
  CalendarHeader: () => <div data-testid="calendar-header" />,
}));

vi.mock('@/contexts/breadcrumb-context', () => ({
  BreadcrumbProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/layout/module-content', () => ({
  ModuleContent: ({
    children,
    aside,
  }: {
    children: ReactNode;
    aside?: ReactNode;
  }) => (
    <div data-testid="module-content">
      <div data-testid="module-content-main">{children}</div>
      <div data-testid="module-content-aside">{aside}</div>
    </div>
  ),
}));

describe('CalendarLayoutClient', () => {
  it('exposes the event panel portal slot in ModuleContent aside', () => {
    render(
      <CalendarLayoutClient>
        <div>calendar-page</div>
      </CalendarLayoutClient>,
    );

    expect(screen.getByTestId('module-content')).toBeInTheDocument();
    expect(screen.getByText('calendar-page')).toBeInTheDocument();

    const slot = document.getElementById('weldcalendar-event-panel-slot');
    expect(slot).not.toBeNull();
    expect(slot).toHaveClass('contents');
    expect(screen.getByTestId('module-content-aside')).toContainElement(slot!);
  });
});
