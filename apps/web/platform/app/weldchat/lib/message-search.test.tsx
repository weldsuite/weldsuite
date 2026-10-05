import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useMessageDeepLink, validateMessageSearch } from './message-search';

function Probe() {
  const { targetMessageId, clearTarget } = useMessageDeepLink();
  return (
    <div>
      <span data-testid="target">{targetMessageId ?? 'none'}</span>
      <button type="button" onClick={clearTarget}>clear</button>
    </div>
  );
}

/** A route WITHOUT validateSearch, like the /preview/weldchat mirror that shares the page components. */
function renderAt(url: string) {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/preview/weldchat/$channelId', component: Probe });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe('validateMessageSearch', () => {
  it('keeps a non-empty string msg and drops anything else', () => {
    expect(validateMessageSearch({ msg: 'msg_1' })).toEqual({ msg: 'msg_1' });
    expect(validateMessageSearch({ msg: '' })).toEqual({ msg: undefined });
    expect(validateMessageSearch({ msg: 5 })).toEqual({ msg: undefined });
    expect(validateMessageSearch({})).toEqual({ msg: undefined });
  });
});

describe('useMessageDeepLink', () => {
  it('works on a route that does not declare the search param (no "active match" error)', async () => {
    renderAt('/preview/weldchat/ch_1?msg=msg_9');
    expect((await screen.findByTestId('target')).textContent).toBe('msg_9');
  });

  it('reports no target when the URL has none', async () => {
    renderAt('/preview/weldchat/ch_1');
    expect((await screen.findByTestId('target')).textContent).toBe('none');
  });

  it('clearTarget removes msg from the URL with a replace navigation', async () => {
    const router = renderAt('/preview/weldchat/ch_1?msg=msg_9&other=1');
    await screen.findByTestId('target');
    const before = router.history.length;

    await act(async () => {
      screen.getByText('clear').click();
    });

    await waitFor(() => expect(screen.getByTestId('target').textContent).toBe('none'));
    expect(router.history.location.search).not.toContain('msg');
    expect(router.history.location.search).toContain('other=1');
    expect(router.history.length).toBe(before);
  });
});
