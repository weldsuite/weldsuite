import { describe, expect, it } from 'vitest';
import type { Room } from 'livekit-client';
import { supportsVideoMiddleware } from '../hooks/use-virtual-background';
import { LiveKitMeeting } from '../providers/livekit';
import type { MeetingClient } from '../types';
import { unavailableTools } from './use-meeting-tools-controller';

const client = (modules: Record<string, unknown>) => modules as unknown as MeetingClient;

describe('meeting tools per video provider', () => {
  it('offers every tool on RealtimeKit, whose client has the transcript, polls and live stream', () => {
    expect(unavailableTools(client({ ai: {}, polls: {}, livestream: {} })).size).toBe(0);
    expect(unavailableTools(null).size).toBe(0);
  });

  it('leaves out the RealtimeKit-only tools on a client without them (LiveKit)', () => {
    const livekit = new LiveKitMeeting({
      url: 'wss://lk.example.eu',
      token: `x.${btoa(JSON.stringify({ sub: 'user_1~a', video: { room: 'r' } }))}.y`,
      room: { on: () => undefined, localParticipant: {} } as unknown as Room,
    });
    const asClient = livekit as unknown as MeetingClient;
    expect([...unavailableTools(asClient)].sort()).toEqual(['livestream', 'polls', 'transcribe', 'translation']);
    // Nor does it take RealtimeKit's video middlewares (background effects).
    expect(supportsVideoMiddleware(asClient)).toBe(false);
    expect(supportsVideoMiddleware(client({ self: { addVideoMiddleware: () => undefined } }))).toBe(true);
  });
});
