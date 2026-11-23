import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';

const breadcrumbs = vi.hoisted(() => vi.fn());

vi.mock('../components/my-hr-page', () => ({ useMyHrBreadcrumbs: breadcrumbs }));
vi.mock('../components/tasks-tab', () => ({ MyTasksTab: () => <p>my tasks list</p> }));

import MyTasksPage from './page';

beforeEach(() => breadcrumbs.mockReset());

describe('MyTasksPage', () => {
  it('sets the Tasks breadcrumb and shows the tasks list in a full-width container', () => {
    render(
      <I18nProvider initialLanguage="en">
        <MyTasksPage />
      </I18nProvider>,
    );
    expect(breadcrumbs).toHaveBeenCalledWith(en.weldhr.me.pages.tasks);
    expect(screen.getByText('my tasks list').parentElement).toHaveClass('@container');
  });
});
