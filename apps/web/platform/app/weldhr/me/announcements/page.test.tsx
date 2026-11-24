import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import MyAnnouncementsPage from './page';

const mocks = vi.hoisted(() => ({ open: vi.fn(), sync: vi.fn(), breadcrumbs: vi.fn() }));
let search: { announcement?: string } = {};

vi.mock('@tanstack/react-router', () => ({ useSearch: () => search }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: mocks.open }),
  useObjectPanelUrlSync: (path: string) => mocks.sync(path),
}));
vi.mock('../components/my-hr-page', () => ({ useMyHrBreadcrumbs: (label: string) => mocks.breadcrumbs(label) }));
vi.mock('../components/announcements-tab', () => ({ MyAnnouncementsList: () => <p>announcements list</p> }));

function renderPage() {
  return render(
    <I18nProvider initialLanguage="en">
      <MyAnnouncementsPage />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.open.mockReset();
  mocks.sync.mockReset();
  mocks.breadcrumbs.mockReset();
  search = {};
});

describe('MyAnnouncementsPage', () => {
  it('renders the list, sets the breadcrumb and syncs the panel with the URL', () => {
    renderPage();

    expect(screen.getByText('announcements list')).toBeInTheDocument();
    expect(mocks.breadcrumbs).toHaveBeenCalledWith('Announcements');
    expect(mocks.sync).toHaveBeenCalledWith('/weldhr/me/announcements');
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('opens the announcement of a push-notification link once', () => {
    search = { announcement: 'ann_1' };
    const { rerender } = renderPage();

    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'ann_1' }));

    rerender(
      <I18nProvider initialLanguage="en">
        <MyAnnouncementsPage />
      </I18nProvider>,
    );
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it('opens another announcement when the link changes', () => {
    search = { announcement: 'ann_1' };
    const { rerender } = renderPage();
    search = { announcement: 'ann_2' };
    rerender(
      <I18nProvider initialLanguage="en">
        <MyAnnouncementsPage />
      </I18nProvider>,
    );

    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'ann_2' }));
  });
});
