/**
 * Copy for the Meeting tools panel and the tools' in-call surfaces. The
 * package has no i18n of its own: host apps pass a translated object with the
 * same shape, and these English strings apply when they pass nothing.
 *
 * `{name}` style placeholders are filled in with {@link formatLabel}.
 */
export interface MeetingToolsLabels {
  back: string;
  hostOnly: string;
  rows: {
    translation: string;
    translationDescription: string;
    translationActive: string;
    timer: string;
    timerDescription: string;
    timerRunning: string;
    timerPaused: string;
    transcribe: string;
    transcribeDescription: string;
    livestream: string;
    livestreamDescription: string;
    livestreamLive: string;
    livestreamUnavailable: string;
    breakout: string;
    breakoutDescription: string;
    breakoutActive: string;
    polls: string;
    pollsDescription: string;
    pollsCount: string;
    qa: string;
    qaDescription: string;
    qaOpen: string;
  };
  timer: {
    hostHint: string;
    idleHint: string;
    enterTime: string;
    customMinutes: string;
    seconds: string;
    start: string;
    cancel: string;
    sound: string;
    pause: string;
    resume: string;
    addMinute: string;
    paused: string;
    timeUp: string;
    started: string;
  };
  transcript: {
    empty: string;
    captions: string;
    captionsHint: string;
    copy: string;
    copied: string;
    download: string;
    fileTitle: string;
  };
  translation: {
    intro: string;
    unsupported: string;
    enable: string;
    spokenLanguage: string;
    targetLanguage: string;
    preparing: string;
    downloading: string;
    ready: string;
    pairUnavailable: string;
    failed: string;
  };
  livestream: {
    intro: string;
    unavailable: string;
    start: string;
    starting: string;
    stop: string;
    stopping: string;
    live: string;
    viewers: string;
    viewerLink: string;
    copyLink: string;
    copied: string;
    startFailed: string;
    stopFailed: string;
    notice: string;
  };
  breakout: {
    intro: string;
    participantHint: string;
    roomCount: string;
    addRoom: string;
    removeRoom: string;
    roomName: string;
    mainRoom: string;
    assignAutomatically: string;
    open: string;
    close: string;
    join: string;
    leave: string;
    youAreHere: string;
    empty: string;
    moveTo: string;
    movedTo: string;
    closed: string;
    stageBadge: string;
  };
  polls: {
    emptyTitle: string;
    empty: string;
    emptyHost: string;
    searchPlaceholder: string;
    noResultsTitle: string;
    noResultsDescription: string;
    filterVote: string;
    filterVoted: string;
    filterNotVoted: string;
    filterVoting: string;
    filterAnonymous: string;
    filterNamed: string;
    newPoll: string;
    question: string;
    questionPlaceholder: string;
    option: string;
    addOption: string;
    removeOption: string;
    anonymous: string;
    create: string;
    cancel: string;
    votes: string;
    yourVote: string;
    createdBy: string;
    newPollToast: string;
    view: string;
    failed: string;
  };
  qa: {
    empty: string;
    placeholder: string;
    ask: string;
    upvote: string;
    markAnswered: string;
    markOpen: string;
    remove: string;
    answered: string;
    askedBy: string;
    newQuestionToast: string;
    view: string;
  };
}

export const DEFAULT_MEETING_TOOLS_LABELS: MeetingToolsLabels = {
  back: 'Back to meeting tools',
  hostOnly: 'Host only',
  rows: {
    translation: 'Speech translation',
    translationDescription: 'Translate captions on your device',
    translationActive: 'Translating to {language}',
    timer: 'Timer',
    timerDescription: 'Show a countdown timer',
    timerRunning: '{time} remaining',
    timerPaused: 'Paused at {time}',
    transcribe: 'Transcribe',
    transcribeDescription: 'Capture the conversation',
    livestream: 'Live streaming',
    livestreamDescription: 'Stream to view-only users',
    livestreamLive: 'Live now',
    livestreamUnavailable: 'Not enabled for this meeting',
    breakout: 'Breakout rooms',
    breakoutDescription: 'Break into smaller groups',
    breakoutActive: 'Rooms open: {count}',
    polls: 'Polls',
    pollsDescription: 'Send polls to the audience',
    pollsCount: 'Polls: {count}',
    qa: 'Q&A',
    qaDescription: 'Ask and answer questions',
    qaOpen: 'Open questions: {count}',
  },
  timer: {
    hostHint: 'Everyone in the meeting sees the countdown.',
    idleHint: 'No timer is running. The host can start a countdown for everyone.',
    enterTime: 'Enter time',
    customMinutes: 'Minutes',
    seconds: 'Seconds',
    start: 'Start',
    cancel: 'Cancel',
    sound: 'Play a sound when the timer ends',
    pause: 'Pause',
    resume: 'Resume',
    addMinute: 'Add 1 minute',
    paused: 'Paused',
    timeUp: "Time's up",
    started: 'A {time} timer started',
  },
  transcript: {
    empty: 'Nothing has been said yet. The transcript appears here as people speak.',
    captions: 'Show captions',
    captionsHint: 'Show what is being said at the bottom of your screen.',
    copy: 'Copy',
    copied: 'Copied',
    download: 'Download',
    fileTitle: 'Transcript',
  },
  translation: {
    intro: 'Captions are translated on your device. Nothing is sent to a translation service, and only you see the translation.',
    unsupported: 'This browser has no built-in translation. Use a recent desktop version of Chrome to translate captions.',
    enable: 'Translate captions',
    spokenLanguage: 'Spoken language',
    targetLanguage: 'Translate to',
    preparing: 'Preparing the translation…',
    downloading: 'Downloading the language pack… {percent}%',
    ready: 'Captions are translated to {language}.',
    pairUnavailable: 'This browser cannot translate between these two languages.',
    failed: "Couldn't start the translation. Please try again.",
  },
  livestream: {
    intro: 'Stream the meeting to people who only watch. Viewers cannot be seen or heard.',
    unavailable: 'Live streaming is not enabled for this meeting.',
    start: 'Go live',
    starting: 'Starting the stream…',
    stop: 'Stop streaming',
    stopping: 'Stopping the stream…',
    live: 'Live',
    viewers: 'Viewers: {count}',
    viewerLink: 'Viewer link',
    copyLink: 'Copy link',
    copied: 'Copied',
    startFailed: "Couldn't start the live stream. Please try again.",
    stopFailed: "Couldn't stop the live stream. Please try again.",
    notice: 'This meeting is being streamed live.',
  },
  breakout: {
    intro: 'Split the meeting into smaller groups. People only see and hear the others in their room.',
    participantHint: 'The host can split the meeting into smaller groups.',
    roomCount: 'Number of rooms',
    addRoom: 'Add a room',
    removeRoom: 'Remove a room',
    roomName: 'Room {number}',
    mainRoom: 'Main room',
    assignAutomatically: 'Assign automatically',
    open: 'Open rooms',
    close: 'Close rooms',
    join: 'Join',
    leave: 'Return to main room',
    youAreHere: 'You are here',
    empty: 'Nobody yet',
    moveTo: 'Move {name} to',
    movedTo: 'You are now in {room}',
    closed: 'The breakout rooms are closed. Everyone is back in the main room.',
    stageBadge: 'Breakout: {room}',
  },
  polls: {
    emptyTitle: 'No polls yet',
    empty: 'The host can start one.',
    emptyHost: 'Create one to ask the audience.',
    searchPlaceholder: 'Search polls...',
    noResultsTitle: 'No polls found',
    noResultsDescription: "We couldn't find a poll matching your filter.",
    filterVote: 'My vote',
    filterVoted: 'Voted',
    filterNotVoted: 'Not voted yet',
    filterVoting: 'Voting',
    filterAnonymous: 'Anonymous',
    filterNamed: 'Named',
    newPoll: 'New poll',
    question: 'Question',
    questionPlaceholder: 'What do you want to ask?',
    option: 'Option {number}',
    addOption: 'Add option',
    removeOption: 'Remove option',
    anonymous: 'Anonymous votes',
    create: 'Start poll',
    cancel: 'Cancel',
    votes: 'Votes: {count}',
    yourVote: 'Your vote',
    createdBy: 'By {name}',
    newPollToast: 'New poll: {question}',
    view: 'View',
    failed: "Couldn't save that. Please try again.",
  },
  qa: {
    empty: 'No questions yet. Be the first to ask.',
    placeholder: 'Ask a question',
    ask: 'Ask',
    upvote: 'Upvote',
    markAnswered: 'Mark as answered',
    markOpen: 'Mark as open',
    remove: 'Remove',
    answered: 'Answered',
    askedBy: 'Asked by {name}',
    newQuestionToast: '{name} asked: {question}',
    view: 'View',
  },
};

/** Fills `{key}` placeholders in a label. Unknown placeholders are left as-is. */
export function formatLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** `m:ss` (or `h:mm:ss`) for a countdown. Rounds up so 0.4s still reads 0:01. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}
