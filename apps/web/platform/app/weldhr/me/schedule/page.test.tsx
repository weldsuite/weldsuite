import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import MySchedulePage from './page';

const t = en.weldhr.me;
const mocks = vi.hoisted(() => ({ breadcrumbs: vi.fn(), urlSync: vi.fn() }));

vi.mock('@/components/object-panel', () => ({ useObjectPanelUrlSync: mocks.urlSync }));
vi.mock('../components/my-hr-page', () => ({ useMyHrBreadcrumbs: mocks.breadcrumbs }));
vi.mock('../../components/page-kit', () => ({
  HrTabsPage: ({
    tabs,
    activeTab,
    onTabChange,
    children,
  }: {
    tabs: { id: string; label: string }[];
    activeTab: string;
    onTabChange: (tab: string) => void;
    children: ReactNode;
  }) => (
    <div>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" aria-pressed={tab.id === activeTab} onClick={() => onTabChange(tab.id)}>
          {tab.label}
        </button>
      ))}
      {children}
    </div>
  ),
}));
vi.mock('../components/open-shifts-card', () => ({ MyOpenShiftsList: () => <p>open shifts list</p> }));
vi.mock('../components/schedule-calendar-tab', () => ({
  MyScheduleCalendar: ({ viewToggle }: { viewToggle: ReactNode }) => (
    <div>
      <p>shifts calendar</p>
      {viewToggle}
    </div>
  ),
}));
vi.mock('../components/schedule-shifts-tab', () => ({
  MyShiftsList: ({
    period,
    onPeriodChange,
    viewToggle,
  }: {
    period: string;
    onPeriodChange: (period: 'thisMonth') => void;
    viewToggle: ReactNode;
  }) => (
    <div>
      <p>shifts list {period}</p>
      <button type="button" onClick={() => onPeriodChange('thisMonth')}>
        pick this month
      </button>
      {viewToggle}
    </div>
  ),
}));
vi.mock('../components/schedule-hours-tab', () => ({
  MyHoursList: ({ period }: { period: string }) => <p>hours list {period}</p>,
}));

function renderPage() {
  render(
    <I18nProvider initialLanguage="en">
      <MySchedulePage />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.breadcrumbs.mockClear();
  mocks.urlSync.mockClear();
});

describe('MySchedulePage', () => {
  it('sets the breadcrumb and keeps the open panel in the URL', () => {
    renderPage();
    expect(mocks.breadcrumbs).toHaveBeenCalledWith(t.pages.schedule);
    expect(mocks.urlSync).toHaveBeenCalled();
  });

  it('opens on the list of shifts', () => {
    renderPage();
    expect(screen.getByText('shifts list around')).toBeInTheDocument();
  });

  it('switches the shifts between the list and the calendar', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: t.schedule.view.calendar }));
    expect(screen.getByText('shifts calendar')).toBeInTheDocument();
    expect(screen.queryByText(/shifts list/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: t.schedule.view.list }));
    expect(screen.getByText('shifts list around')).toBeInTheDocument();
  });

  it('shows the open shifts tab', async () => {
    renderPage();
    await userEvent.setup().click(screen.getByRole('button', { name: t.schedule.tabs.openShifts }));
    expect(screen.getByText('open shifts list')).toBeInTheDocument();
  });

  it('shares the picked period between the Shifts and Hours tabs', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'pick this month' }));
    await user.click(screen.getByRole('button', { name: t.schedule.tabs.hours }));
    expect(screen.getByText('hours list thisMonth')).toBeInTheDocument();
  });
});
