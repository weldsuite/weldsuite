import { Profiler, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { RecentActivityTable, type ActivityItem } from './recent-workflows-table';

const router = { push: vi.fn() };

vi.mock('@/lib/router', () => ({
  useRouter: () => router,
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

function activity(detail: string): ActivityItem {
  return {
    id: 'wex_1',
    workflowId: 'wf_1',
    status: 'running',
    customerName: 'Sync orders',
    customerInitial: 'S',
    avatarColor: 'bg-blue-500',
    description: 'Triggered via Schedule',
    detail,
    timestamp: new Date(),
    href: '/weldconnect/executions/wex_1',
  };
}

describe('RecentActivityTable', () => {
  // The dashboard re-renders the table every second while a run is active (its
  // elapsed time ticks). That used to start an endless render loop that crashed
  // the tab: a new translator per render recomputed the rows, and every new row
  // set queued a page-index reset that rendered the table again.
  it('settles after its rows change instead of rendering forever', async () => {
    let commits = 0;
    const tree = (activities: ActivityItem[]) => (
      <I18nProvider initialLanguage="en">
        <Profiler id="table" onRender={() => { commits++; }}>
          <RecentActivityTable activities={activities} />
        </Profiler>
      </I18nProvider>
    );

    const { rerender } = render(tree([activity('1.0s')]));
    await act(async () => { await Promise.resolve(); });

    for (const detail of ['2.0s', '3.0s', '4.0s']) {
      rerender(tree([activity(detail)]));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }

    expect(screen.getByText('4.0s')).toBeInTheDocument();
    expect(commits).toBeLessThan(20);
  });
});
