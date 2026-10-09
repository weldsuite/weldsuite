import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { MeetingClient, MeetingPeer } from '../types';
import { DEFAULT_MEETING_TOOLS_LABELS, formatCountdown, formatLabel, type MeetingToolsLabels } from './labels';
import type { MeetingToolsEvent, MeetingToolsState, MeetingToolsStore } from './tools-store';
import { useCaptionTranslation, type CaptionTranslation } from './translation';
import {
  useLiveTranscript,
  useMeetingLivestream,
  useMeetingPolls,
  useMeetingToolsState,
  useMeetingToolsStore,
  type MeetingLivestream,
  type MeetingPoll,
  type MeetingPolls,
  type TranscriptLine,
} from './use-meeting-tools';

export type MeetingToolKey = 'translation' | 'timer' | 'transcribe' | 'livestream' | 'breakout' | 'polls' | 'qa';

/** Everything the Meeting tools panel and the stage need from the tools, in one object. */
export interface MeetingToolsController {
  store: MeetingToolsStore;
  state: MeetingToolsState;
  polls: MeetingPolls;
  livestream: MeetingLivestream;
  transcript: TranscriptLine[];
  translation: CaptionTranslation;
  /** The lines for the on-screen captions, translated when the viewer turned that on. */
  captions: TranscriptLine[];
  /** This viewer asked for captions (or a translation of them), whatever the host policy says. */
  wantsCaptions: boolean;
  isOrganizer: boolean;
  /** Everyone in the meeting, local participant first (not filtered by breakout room). */
  participants: MeetingPeer[];
  meetingTitle?: string;
  labels: MeetingToolsLabels;
  /** The tool whose view is open in the panel, or null for the list. */
  activeTool: MeetingToolKey | null;
  setActiveTool: (tool: MeetingToolKey | null) => void;
}

interface ControllerOptions {
  meeting: MeetingClient | null;
  participants: MeetingPeer[];
  isOrganizer: boolean;
  meetingTitle?: string;
  labels?: MeetingToolsLabels;
  /** The host app's rolling caption buffer. The live transcript is used when omitted. */
  captions?: TranscriptLine[];
  /** The Meeting tools panel is the open right panel. */
  panelOpen: boolean;
  /** Opens the Meeting tools panel (used by the "View" action on a notification). */
  onOpenPanel: () => void;
}

/** How many of the newest transcript lines are kept translated while the transcript is open. */
const TRANSLATED_TRANSCRIPT_LINES = 40;
/** The captions overlay shows the last two lines. */
const CAPTION_LINES = 2;

/** Two short tones when the countdown ends. Silent where audio is not allowed yet. */
function playTimerEndSound(): void {
  try {
    const Ctx = globalThis.AudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [0, 0.28].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.24);
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 1000);
  } catch {
    /* no audio */
  }
}

/**
 * Wires the meeting tools to one meeting: shared state, RealtimeKit polls /
 * transcript / livestream, caption translation and the notifications people
 * get when something happens while the panel is closed. Null until a meeting
 * client exists.
 */
export function useMeetingToolsController(options: ControllerOptions): MeetingToolsController | null {
  const { meeting, participants, isOrganizer, meetingTitle, panelOpen, onOpenPanel } = options;
  const labels = options.labels ?? DEFAULT_MEETING_TOOLS_LABELS;
  const store = useMeetingToolsStore(meeting);
  const state = useMeetingToolsState(store);
  const [activeTool, setActiveTool] = useState<MeetingToolKey | null>(null);

  // Notification handlers read the latest props through a ref, so the
  // subscriptions below are set up once per meeting instead of on every render.
  const latest = useRef({ labels, panelOpen, activeTool, onOpenPanel });
  latest.current = { labels, panelOpen, activeTool, onOpenPanel };

  const openTool = useCallback((tool: MeetingToolKey) => {
    setActiveTool(tool);
    latest.current.onOpenPanel();
  }, []);
  const isViewing = (tool: MeetingToolKey) => latest.current.panelOpen && latest.current.activeTool === tool;

  const onNewPoll = useCallback(
    (poll: MeetingPoll) => {
      if (isViewing('polls')) return;
      const t = latest.current.labels.polls;
      toast(formatLabel(t.newPollToast, { question: poll.question }), {
        action: { label: t.view, onClick: () => openTool('polls') },
      });
    },
    [openTool],
  );

  const polls = useMeetingPolls(meeting, onNewPoll);
  const livestream = useMeetingLivestream(meeting);
  const transcript = useLiveTranscript(meeting);

  useEffect(() => {
    if (!store) return;
    return store.onEvent((event: MeetingToolsEvent) => {
      const l = latest.current.labels;
      switch (event.type) {
        case 'timer-started':
          toast(formatLabel(l.timer.started, { time: formatCountdown(event.durationMs) }));
          break;
        case 'timer-ended':
          if (store.getState().prefs.timerSound) playTimerEndSound();
          toast(l.timer.timeUp);
          break;
        case 'question-asked':
          if (isViewing('qa')) break;
          toast(
            formatLabel(l.qa.newQuestionToast, { name: event.question.authorName, question: event.question.text }),
            { action: { label: l.qa.view, onClick: () => openTool('qa') } },
          );
          break;
        case 'breakout-room-changed':
          toast(
            event.active
              ? formatLabel(l.breakout.movedTo, { room: event.roomName ?? l.breakout.mainRoom })
              : l.breakout.closed,
          );
          break;
        default:
          break;
      }
    });
  }, [store, openTool]);

  const { translationEnabled, translateFrom, translateTo } = state.prefs;
  const transcriptOpen = panelOpen && activeTool === 'transcribe';
  const captionBuffer = options.captions;
  const captionSource = useMemo(
    () => (captionBuffer ?? transcript).slice(-CAPTION_LINES),
    [captionBuffer, transcript],
  );
  const texts = useMemo(() => {
    if (!translationEnabled) return [];
    const fromTranscript = transcriptOpen ? transcript.slice(-TRANSLATED_TRANSCRIPT_LINES) : [];
    return [...fromTranscript, ...captionSource].map((line) => line.text);
  }, [translationEnabled, transcriptOpen, transcript, captionSource]);
  const translation = useCaptionTranslation({
    enabled: translationEnabled,
    from: translateFrom,
    to: translateTo,
    texts,
  });

  if (!store) return null;
  return {
    store,
    state,
    polls,
    livestream,
    transcript,
    translation,
    captions: translationEnabled
      ? captionSource.map((line) => ({ ...line, text: translation.translate(line.text) }))
      : captionSource,
    wantsCaptions: state.prefs.captions || translationEnabled,
    isOrganizer,
    participants,
    meetingTitle,
    labels,
    activeTool,
    setActiveTool,
  };
}
