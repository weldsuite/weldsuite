/**
 * The host's own room administration on LiveKit: what RealtimeKit's host
 * preset lets the host's client do itself (admit and reject waiting guests,
 * mute someone, remove someone). The host's join token carries `roomAdmin`
 * for its room, so the client calls LiveKit's `RoomService` (Twirp, JSON)
 * with it directly; no other token can.
 *
 * Removing a participant for good and ending the meeting still go through
 * the meet API, as on RealtimeKit: the server records the removal and closes
 * the room (`DynVideoRooms` in `rust/crates/video-rooms`).
 */

import { WAITING_ATTRIBUTE, liveKitApiBase } from './token';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class LiveKitRoomService {
  private readonly base: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly room: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.base = liveKitApiBase(url);
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ room: this.room, ...body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LiveKit ${method} failed: ${res.status} ${text}`.trim());
    }
    return res.json().catch(() => ({}));
  }

  /** Disconnect someone (RealtimeKit's `participant.kick()`). */
  removeParticipant(identity: string): Promise<unknown> {
    return this.call('RemoveParticipant', { identity });
  }

  /** Mute one of someone's published tracks (RealtimeKit's `disableAudio()`/`disableVideo()`). */
  mutePublishedTrack(identity: string, trackSid: string): Promise<unknown> {
    return this.call('MutePublishedTrack', { identity, track_sid: trackSid, muted: true });
  }

  /** Let a waiting guest in: clear the waiting flag and let them send and receive. */
  admit(identity: string): Promise<unknown> {
    return this.call('UpdateParticipant', {
      identity,
      attributes: { [WAITING_ATTRIBUTE]: '' },
      permission: { can_subscribe: true, can_publish: true, can_publish_data: true },
    });
  }
}
