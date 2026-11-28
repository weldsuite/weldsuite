import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ActivityTimeline } from './activity-timeline';

describe('ActivityTimeline', () => {
  afterEach(cleanup);

  it('lists the events in the order given, in a named ordered list', () => {
    render(
      <ActivityTimeline
        label="What happened"
        items={[
          { id: 'a', title: 'Created', time: '3 Nov', dateTime: '2026-11-03' },
          { id: 'b', title: 'E-mailed', description: 'To a@b.test' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'What happened' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Created');
    expect(items[1]?.textContent).toContain('To a@b.test');
    expect(list.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-03');
  });

  it('marks an event that has not happened yet and says so to screen readers', () => {
    render(<ActivityTimeline label="x" items={[{ id: 'n', title: 'Reminder 2', upcoming: true, srPrefix: 'Planned:' }]} />);
    const item = screen.getByRole('listitem');
    expect(item.hasAttribute('data-upcoming')).toBe(true);
    expect(item.textContent).toContain('Planned: Reminder 2');
  });
});
