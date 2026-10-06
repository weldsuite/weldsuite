/**
 * A fake meeting room for the meeting-tools component tests.
 *
 * Playwright CT cannot pass a live RealtimeKit client (or any object with
 * methods) from the test into the page, so the fake clients are built here, in
 * the browser. Every peer gets its own fake client; a broadcast from one is
 * delivered to all of them (the sender included, like RealtimeKit's echo), and
 * polls / live stream / transcript are shared room state. That is enough to
 * run the real controller and store on several "people" side by side and watch
 * the tools stay in sync.
 */
import { useMemo, useState } from 'react';
import { MeetingToolsPanel } from '../../src/components/meeting-tools-panel';
import { StageIndicators } from '../../src/components/tools/stage-indicators';
import { filterBreakoutParticipants } from '../../src/tools/tools-store';
import { useMeetingToolsController } from '../../src/tools/use-meeting-tools-controller';
import type { MeetingPoll } from '../../src/tools/use-meeting-tools';
import type { MeetingClient, MeetingPeer } from '../../src/types';

type Handler = (...args: never[]) => void;

class Emitter {
  private readonly handlers = new Map<string, Set<Handler>>();
  on = (event: string, handler: Handler) => {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  };
  off = (event: string, handler: Handler) => {
    this.handlers.get(event)?.delete(handler);
  };
  emit(event: string, ...args: unknown[]) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      (handler as (...a: unknown[]) => void)(...args);
    }
  }
}

interface FakePeer {
  key: string;
  name: string;
  isHost: boolean;
  meeting: MeetingClient;
  participants: Emitter;
  polls: Emitter;
  ai: Emitter;
  livestream: Emitter & { state: string; viewerCount: number; playbackUrl?: string };
}

class FakeRoom {
  readonly peers: FakePeer[] = [];
  readonly pollItems: MeetingPoll[] = [];
  readonly transcripts: unknown[] = [];

  join(key: string, name: string, isHost: boolean): FakePeer {
    const participants = new Emitter();
    const polls = new Emitter();
    const ai = new Emitter();
    const livestream = Object.assign(new Emitter(), { state: 'IDLE', viewerCount: 0, playbackUrl: undefined });
    const self = {
      id: `peer-${key}`,
      userId: key,
      customParticipantId: key,
      name,
      permissions: { polls: { canCreate: true, canVote: true, canView: true }, canLivestream: isHost },
    };
    const meeting = {
      self,
      participants: {
        on: participants.on,
        off: participants.off,
        broadcastMessage: (type: string, payload: Record<string, unknown>) => {
          // Delivered asynchronously, to everyone in the room, sender included.
          setTimeout(() => {
            for (const peer of this.peers) {
              peer.participants.emit('broadcastedMessage', { type, payload, timestamp: Date.now() });
            }
          }, 0);
          return Promise.resolve();
        },
      },
      polls: {
        // The same array the room mutates, so a client that mounts later sees every poll.
        items: this.pollItems,
        on: polls.on,
        off: polls.off,
        create: async (question: string, options: string[], anonymous: boolean) => {
          this.pollItems.push({
            id: `poll-${this.pollItems.length + 1}`,
            question,
            options: options.map((text) => ({ text, count: 0, votes: [] })),
            anonymous,
            hideVotes: false,
            createdBy: name,
            createdByUserId: key,
            voted: [],
          });
          this.emitPolls(true);
        },
        vote: async (id: string, index: number) => {
          const poll = this.pollItems.find((p) => p.id === id);
          const option = poll?.options[index];
          if (!poll || !option || poll.voted.includes(key)) return;
          option.count += 1;
          if (!poll.anonymous) option.votes.push({ id: key, name });
          poll.voted.push(key);
          this.emitPolls(false);
        },
      },
      ai: {
        transcripts: this.transcripts,
        on: ai.on,
        off: ai.off,
      },
      livestream: Object.assign(livestream, {
        start: async () => this.setLive(true),
        stop: async () => this.setLive(false),
      }),
    };
    const peer: FakePeer = {
      key,
      name,
      isHost,
      meeting: meeting as unknown as MeetingClient,
      participants,
      polls,
      ai,
      livestream,
    };
    this.peers.push(peer);
    return peer;
  }

  private emitPolls(newPoll: boolean) {
    for (const peer of this.peers) {
      peer.polls.emit('pollsUpdate', { polls: this.pollItems.map((p) => ({ ...p })), newPoll });
    }
  }

  private setLive(live: boolean) {
    for (const peer of this.peers) {
      peer.livestream.state = live ? 'LIVESTREAMING' : 'IDLE';
      peer.livestream.viewerCount = live ? 3 : 0;
      peer.livestream.playbackUrl = live
        ? 'https://customer-abc123.cloudflarestream.com/0f1e2d3c/manifest/video.m3u8'
        : undefined;
      peer.livestream.emit('livestreamUpdate', peer.livestream.state);
    }
  }

  say(speaker: FakePeer, text: string) {
    const line = {
      id: `t-${this.transcripts.length + 1}`,
      peerId: speaker.meeting.self.id,
      name: speaker.name,
      transcript: text,
      isPartialTranscript: false,
      date: new Date(),
    };
    this.transcripts.push(line);
    for (const peer of this.peers) peer.ai.emit('transcript', line);
  }
}

function toMeetingPeer(peer: FakePeer): MeetingPeer {
  return {
    id: `peer-${peer.key}`,
    userId: peer.key,
    customParticipantId: peer.key,
    name: peer.name,
    audioEnabled: false,
    videoEnabled: false,
  };
}

function PeerView({ peer, everyone }: { peer: FakePeer; everyone: FakePeer[] }) {
  // The local participant comes first, as everywhere in this package.
  const participants = useMemo(
    () => [peer, ...everyone.filter((other) => other !== peer)].map(toMeetingPeer),
    [peer, everyone],
  );
  const tools = useMeetingToolsController({
    meeting: peer.meeting,
    participants,
    isOrganizer: peer.isHost,
    meetingTitle: 'Weekly sync',
    panelOpen: true,
    onOpenPanel: () => {},
  });
  const onStage = tools ? filterBreakoutParticipants(tools.state.breakout, participants) : participants;

  return (
    <section
      data-testid={`peer-${peer.key}`}
      style={{ position: 'relative', width: 380, height: 760, border: '1px solid #ccc', display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ position: 'relative', minHeight: 72, flexShrink: 0 }}>
        {tools && <StageIndicators tools={tools} />}
        <p data-testid="stage" style={{ margin: 0, paddingTop: 44, fontSize: 12 }}>
          {onStage.map((p) => p.name).join(', ')}
        </p>
        {tools && tools.wantsCaptions && (
          <p data-testid="captions" style={{ margin: 0, fontSize: 12 }}>
            {tools.captions.map((line) => line.text).join(' | ')}
          </p>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MeetingToolsPanel
          tools={tools}
          recordingAvailable={peer.isHost}
          startRecording={() => {}}
          stopRecording={() => {}}
        />
      </div>
    </section>
  );
}

export interface ToolsHarnessProps {
  /** Install a stand-in for the browser's Translator API that upper-cases text. */
  fakeTranslator?: boolean;
}

/**
 * A host (Ada) and a guest (Ben) in one room, each with their own Meeting
 * tools panel. "Add late joiner" lets Cy walk in after things have started.
 */
export function ToolsHarness({ fakeTranslator }: ToolsHarnessProps) {
  const [room] = useState(() => {
    if (fakeTranslator) {
      (globalThis as { Translator?: unknown }).Translator = {
        availability: async () => 'available',
        create: async () => ({ translate: async (text: string) => text.toUpperCase() }),
      };
    }
    const created = new FakeRoom();
    created.join('ada', 'Ada', true);
    created.join('ben', 'Ben', false);
    return created;
  });
  const [peers, setPeers] = useState<FakePeer[]>(() => [...room.peers]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => {
            room.join('cy', 'Cy', false);
            setPeers([...room.peers]);
          }}
        >
          Add late joiner
        </button>
        <button type="button" onClick={() => room.say(room.peers[0]!, 'Hello everyone')}>
          Ada speaks
        </button>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        {peers.map((peer) => (
          <PeerView key={peer.key} peer={peer} everyone={peers} />
        ))}
      </div>
    </div>
  );
}
