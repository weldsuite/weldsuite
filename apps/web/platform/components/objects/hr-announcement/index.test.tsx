import { Suspense, type ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const registered = vi.hoisted(() => [] as Array<{ type: string; label: string; component: ComponentType<Record<string, unknown>> }>);

vi.mock('@/components/object-panel', () => ({
  registerObjectPanel: (entry: (typeof registered)[number]) => registered.push(entry),
}));
vi.mock('./hr-announcement-panel', () => ({ HrAnnouncementPanel: () => <p>Announcement panel body</p> }));

import { HR_ANNOUNCEMENT_PANEL_TYPE } from './types';
import './index';

describe('hr-announcement panel registration', () => {
  it('registers the announcement panel, loaded only when it is opened', async () => {
    expect(registered).toHaveLength(1);
    const [entry] = registered;
    expect(entry).toMatchObject({ type: HR_ANNOUNCEMENT_PANEL_TYPE, label: 'Announcement' });
    expect(HR_ANNOUNCEMENT_PANEL_TYPE).toBe('hr_announcement');

    const Panel = entry.component;
    render(
      <Suspense fallback={<p>Loading</p>}>
        <Panel />
      </Suspense>,
    );
    expect(await screen.findByText('Announcement panel body')).toBeInTheDocument();
  });
});
