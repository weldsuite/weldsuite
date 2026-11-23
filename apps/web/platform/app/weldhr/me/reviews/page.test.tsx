import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';

const mocks = vi.hoisted(() => ({ urlSync: vi.fn(), breadcrumbs: vi.fn() }));

vi.mock('@/components/object-panel', () => ({ useObjectPanelUrlSync: mocks.urlSync }));
vi.mock('../components/my-hr-page', () => ({ useMyHrBreadcrumbs: mocks.breadcrumbs }));
vi.mock('../components/reviews-tab', () => ({
  MyEvaluationsList: () => <p>evaluations list</p>,
  MyCoachingList: () => <p>coaching list</p>,
}));
vi.mock('../components/goals-tab', () => ({
  MyKpisList: () => <p>kpis list</p>,
  MyMilestonesList: () => <p>milestones list</p>,
}));

import MyReviewsPage from './page';

beforeEach(() => {
  mocks.urlSync.mockReset();
  mocks.breadcrumbs.mockReset();
});

function renderPage() {
  return render(
    <I18nProvider initialLanguage="en">
      <MyReviewsPage />
    </I18nProvider>,
  );
}

describe('MyReviewsPage', () => {
  it('sets the breadcrumb and keeps the open panel in the URL', () => {
    renderPage();

    expect(mocks.breadcrumbs).toHaveBeenCalledWith('Performance');
    expect(mocks.urlSync).toHaveBeenCalledWith('/weldhr/me/reviews');
  });

  it('opens on the evaluations and shows one list per tab', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByText('evaluations list')).toBeInTheDocument();
    expect(screen.queryByText('coaching list')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Coaching' }));
    expect(screen.getByText('coaching list')).toBeInTheDocument();
    expect(screen.queryByText('evaluations list')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'KPIs' }));
    expect(screen.getByText('kpis list')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Milestones' }));
    expect(screen.getByText('milestones list')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Evaluations' }));
    expect(screen.getByText('evaluations list')).toBeInTheDocument();
  });
});
