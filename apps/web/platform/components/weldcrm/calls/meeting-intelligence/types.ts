import type { ReactNode } from 'react';

interface SessionParticipantInfo {
  userId: string;
  userName: string;
  userAvatar?: string;
  joinedAt: string;
  leftAt?: string;
}

/** A meeting attendee with optional links to a team member or CRM contact. */
export interface MeetingAttendeeDetail {
  name?: string;
  email?: string;
  avatar?: string;
  role?: 'organizer' | 'attendee';
  /** Links the row to a team member profile when matched. */
  workspaceMemberId?: string;
  /** Links the row to a CRM contact when matched. */
  contactId?: string;
}

export interface MeetingIntelligenceCall {
  id: string;
  subject: string;
  description?: string;
  date: string;
  duration?: number;
  attendees?: string[];
  /** Rich attendee data with profile links; preferred over `attendees` for the participants list. */
  attendeeDetails?: MeetingAttendeeDetail[];
  tags?: string[];
  meetingUrl?: string;
  platform?: string;
  /** Session participant join/leave data (from meeting session) */
  sessionParticipants?: SessionParticipantInfo[];
  /** Total meeting duration in seconds (from session) */
  sessionDuration?: number;
  /** When the session started */
  sessionStartedAt?: string;
  /** When the session ended */
  sessionEndedAt?: string;
}

export interface WordTiming {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptionSegment {
  id: string;
  speaker?: string;
  speakerName?: string;
  text: string;
  start: number;
  end: number;
  timestamp?: string;
  words?: WordTiming[] | null;
}

export interface TranscriptionData {
  id: string;
  status: string;
  fullText?: string;
  summary?: string;
  actionItems?: string[];
  speakerCount?: number;
  wordCount?: number;
  segments?: TranscriptionSegment[];
}

export interface TranscriptionActions {
  onTranscribe: (id: string) => Promise<{ success: boolean; error?: string; message?: string }>;
  onFetchTranscription: (id: string) => Promise<{ success: boolean; transcription?: TranscriptionData | null }>;
  onPollStatus: (id: string) => Promise<{ status?: { status?: string; errorMessage?: string } }>;
}

export interface HeaderAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
  disabled?: boolean;
}

export interface SpeakerInfo {
  id: number;
  label: string;
  name: string | null;
  segmentCount: number;
  totalDuration: number;
  firstSegmentStart: number;
  segments: { start: number; end: number }[];
}

export interface SpeakerColor {
  bg: string;
  ring: string;
  text: string;
  light: string;
}

export interface FlatTimelineSegment {
  start: number;
  end: number;
  hex: string;
  speakerId: number;
}

export interface MeetingIntelligenceProps {
  call: MeetingIntelligenceCall;
  recordingUrl?: string;
  mediaType?: 'video' | 'audio' | 'none';
  initialTranscription?: TranscriptionData | null;
  fetchTranscriptionOnMount?: boolean;
  transcriptionActions?: TranscriptionActions;
  enableFloatingVideo?: boolean;
  enableWeldAgent?: boolean;
  onDelete?: (id: string) => Promise<{ success: boolean; error?: string }>;
  deleteRedirectUrl?: string;
  backUrl?: string;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  tabs?: ('transcript' | 'speakers' | 'meeting')[];
  layout?: 'full-width' | 'grid';
  renderSidebar?: (props: { transcription: TranscriptionData | null }) => ReactNode;
  headerActions?: HeaderAction[];
  headerMenuActions?: {
    onCopyJoinCode?: () => void;
    onCopyLink?: () => void;
    onRename?: () => void;
    onScheduleAgain?: () => void;
    onDownloadRecording?: () => void;
    onDeleteRecording?: () => void;
    onExportTranscript?: () => void;
  };
}
