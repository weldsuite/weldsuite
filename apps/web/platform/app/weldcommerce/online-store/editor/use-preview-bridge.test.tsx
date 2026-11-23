import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { BRIDGE_SOURCE, type PreviewMessage } from '../lib/bridge';

const env = vi.hoisted(() => ({ createLink: vi.fn() }));

vi.mock('@/hooks/queries/use-online-store-queries', () => ({
  useCreatePreviewLink: () => ({ mutateAsync: env.createLink }),
}));

import { usePreviewBridge } from './use-preview-bridge';

const URL_ = 'https://myshop.weldshop.eu/__preview?token=abc';
const ORIGIN = 'https://myshop.weldshop.eu';

function Harness({ onMessage }: Readonly<{ onMessage: (message: PreviewMessage) => void }>) {
  const bridge = usePreviewBridge({ siteId: 'sfs_1', enabled: true, onMessage });
  return (
    <div>
      {bridge.url && <iframe ref={bridge.frameRef} src={bridge.url} title="preview" />}
      <p data-testid="state">{bridge.state}</p>
      <button type="button" onClick={() => bridge.send({ type: 'highlight', sectionId: 'hero' })}>
        send
      </button>
    </div>
  );
}

function post(data: unknown, origin: string, source: MessageEventSource | null) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  });
}

beforeEach(() => {
  env.createLink.mockReset();
  env.createLink.mockResolvedValue({ data: { url: URL_, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
});

describe('usePreviewBridge', () => {
  async function ready() {
    const onMessage = vi.fn();
    render(<Harness onMessage={onMessage} />);
    const frame = (await screen.findByTitle('preview')) as HTMLIFrameElement;
    expect(env.createLink).toHaveBeenCalledWith('sfs_1');
    expect(frame.getAttribute('src')).toBe(URL_);
    return { onMessage, frame };
  }

  it('takes messages from its own frame on the preview origin', async () => {
    const { onMessage, frame } = await ready();
    post({ source: BRIDGE_SOURCE, type: 'ready', path: '/' }, ORIGIN, frame.contentWindow);
    expect(screen.getByTestId('state').textContent).toBe('ready');
    post({ source: BRIDGE_SOURCE, type: 'select', sectionId: 'hero', list: 'home' }, ORIGIN, frame.contentWindow);
    expect(onMessage).toHaveBeenLastCalledWith({ type: 'select', sectionId: 'hero', list: 'home' });
  });

  it('ignores the same message from another origin or another window', async () => {
    const { onMessage, frame } = await ready();
    post({ source: BRIDGE_SOURCE, type: 'select', sectionId: 'hero', list: 'home' }, 'https://evil.example', frame.contentWindow);
    post({ source: BRIDGE_SOURCE, type: 'select', sectionId: 'hero', list: 'home' }, ORIGIN, window);
    post({ source: BRIDGE_SOURCE, type: 'ready', path: '/' }, 'null', frame.contentWindow);
    expect(onMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId('state').textContent).toBe('loading');
  });

  it('posts to the frame, addressed to the preview origin', async () => {
    const { frame } = await ready();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    act(() => screen.getByRole('button', { name: 'send' }).click());
    expect(postMessage).toHaveBeenCalledWith({ source: BRIDGE_SOURCE, type: 'highlight', sectionId: 'hero' }, ORIGIN);
  });

  it('fails instead of framing a link that is not an http(s) address', async () => {
    env.createLink.mockResolvedValue({ data: { url: 'javascript:alert(1)', expiresAt: '2099-01-01T00:00:00Z' } });
    render(<Harness onMessage={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error'));
    expect(screen.queryByTitle('preview')).toBeNull();
  });
});
