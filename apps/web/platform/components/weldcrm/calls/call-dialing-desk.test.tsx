/**
 * `usePlaceCall` with a WeldDesk conversation: the call row is created with
 * `deskConversationId` (so the server logs the call on that timeline), and
 * left out of it for every other caller.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/auth', () => ({ useOrganization: () => ({ organization: { id: 'org_1' } }) }));
vi.mock('@/hooks/queries', () => ({ useFetchVoiceToken: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const startCall = vi.hoisted(() => vi.fn());
vi.mock('@/contexts/call-context', () => ({ useCall: () => ({ startCall }) }));

const client = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => client }),
}));

import { usePlaceCall } from './call-dialing';

beforeEach(() => {
  startCall.mockReset();
  startCall.mockResolvedValue({ success: true });
  client.post.mockReset();
  client.post.mockResolvedValue({ data: { id: 'call_1' } });
});

describe('usePlaceCall', () => {
  it('creates the call row on the desk conversation, then dials', async () => {
    const { result } = renderHook(() => usePlaceCall());
    await act(async () => {
      await result.current.dial({
        toNumber: '+31612345678',
        fromNumber: '+31200000000',
        enableRecording: true,
        deskConversationId: 'dconv_1',
      });
    });
    expect(client.post).toHaveBeenCalledWith(
      '/calls',
      expect.objectContaining({ direction: 'outbound', toNumber: '+31612345678', deskConversationId: 'dconv_1' }),
    );
    expect(startCall).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call_1', toNumber: '+31612345678' }));
  });

  it('leaves the field out for a call that is not about a conversation', async () => {
    const { result } = renderHook(() => usePlaceCall());
    await act(async () => {
      await result.current.dial({ toNumber: '+31612345678', fromNumber: '+31200000000', enableRecording: true });
    });
    const body = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect('deskConversationId' in body).toBe(false);
  });

  it('does not dial when the call row cannot be created', async () => {
    client.post.mockRejectedValue(new Error('Insufficient credits'));
    const { result } = renderHook(() => usePlaceCall());
    await act(async () => {
      await result.current.dial({
        toNumber: '+31612345678',
        fromNumber: '+31200000000',
        enableRecording: true,
        deskConversationId: 'dconv_1',
      });
    });
    expect(startCall).not.toHaveBeenCalled();
  });
});
