import { Suspense, type ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const registered = vi.hoisted(() => [] as Array<{ type: string; label: string; component: ComponentType<Record<string, unknown>> }>);

vi.mock('@/components/object-panel', () => ({
  registerObjectPanel: (entry: (typeof registered)[number]) => registered.push(entry),
}));
vi.mock('./hr-shift-panel', () => ({ HrShiftPanel: () => <p>Shift panel body</p> }));
vi.mock('./hr-shift-request-panel', () => ({ HrShiftRequestPanel: () => <p>Shift request panel body</p> }));

import { HR_SHIFT_PANEL_TYPE, HR_SHIFT_REQUEST_PANEL_TYPE } from './types';
import './index';

describe('hr-shift panel registration', () => {
  it('registers the shift and shift request panels, each loaded only when opened', async () => {
    expect(registered.map(({ type, label }) => ({ type, label }))).toEqual([
      { type: HR_SHIFT_PANEL_TYPE, label: 'Shift' },
      { type: HR_SHIFT_REQUEST_PANEL_TYPE, label: 'Shift request' },
    ]);

    for (const [index, text] of ['Shift panel body', 'Shift request panel body'].entries()) {
      const Panel = registered[index].component;
      const { unmount } = render(
        <Suspense fallback={<p>Loading</p>}>
          <Panel />
        </Suspense>,
      );
      expect(await screen.findByText(text)).toBeInTheDocument();
      unmount();
    }
  });
});
