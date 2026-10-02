
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Tabs, TabsContent } from '@weldsuite/ui/components/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Captions,
  Sparkles,
  Users,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWeldAgentSafe } from '@/components/weldagent-wrapper';
import { useFloatingVideo } from '@/contexts/floating-video-context';
import { useFloatingCall } from '@/contexts/floating-call-context';

import { MeetingIntelligenceHeader } from './meeting-intelligence-header';
import { VideoPlayer } from './video-player';
import { AudioPlayer } from './audio-player';
import { TranscriptTabContent } from './transcript-tab';
import { SpeakersTabContent } from './speakers-tab';
import { MeetingDetailsTab } from './meeting-details-tab';
import { getSpeakerHex } from './speaker-colors';
import { parseSpeakerId, isTranscriptionInProgress, usableTranscription } from './utils';
import { useActiveWord } from './use-active-word';
import { useTranslations } from '@weldsuite/i18n/client';
import type {
  MeetingIntelligenceProps,
  TranscriptionData,
  SpeakerInfo,
  FlatTimelineSegment,
} from './types';

export function MeetingIntelligence({
  call,
  recordingUrl,
  recordingUrlExpiresAt,
  onRefreshRecordingUrl,
  mediaType = 'video',
  initialTranscription,
  fetchTranscriptionOnMount = false,
  transcriptionActions,
  enableFloatingVideo = false,
  enableWeldAgent = false,
  onDelete,
  deleteRedirectUrl,
  backUrl,
  breadcrumbs,
  tabs = ['transcript', 'speakers', 'meeting'],
  renderSidebar,
  headerActions,
  headerMenuActions,
  tabLabels,
  renderSummary,
  mediaSlot,
  transcriptionPending = false,
  transcriptionRefreshKey,
  transcriptEmptyHint,
}: MeetingIntelligenceProps) {
  const t = useTranslations();
  const router = useRouter();
  const floatingVideoCtx = useFloatingVideo();
  const floatingCallCtx = useFloatingCall();

  const isAudio = mediaType === 'audio';

  // Media state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(call.duration || 0);
  const [smoothTime, setSmoothTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const mediaRef = isAudio ? audioRef : videoRef;
  const rafRef = useRef<number>(0);
  const pendingRestoreRef = useRef<{ currentTime: number; isPlaying: boolean } | null>(null);
  // True while we force the browser to compute a header-less recording's real
  // duration (seek-to-end trick) — suppresses the bogus timeupdate during it.
  const durationFixingRef = useRef(false);

  // Stabilize recording URL
  const stableRecordingUrl = useRef(recordingUrl);
  if (recordingUrl && !stableRecordingUrl.current) {
    stableRecordingUrl.current = recordingUrl;
  }

  // Short-lived playback URLs (private recordings): renew the one in use before
  // it expires, or when the media element fails, and resume where it was.
  const [activeExpiresAt, setActiveExpiresAt] = useState<string | null>(null);
  const [, setSourceVersion] = useState(0);
  const expirySeededRef = useRef(false);
  const refreshingRef = useRef(false);
  const lastRefreshAtRef = useRef(0);
  const refreshCallbackRef = useRef(onRefreshRecordingUrl);
  refreshCallbackRef.current = onRefreshRecordingUrl;

  // Transcription state
  const [transcription, setTranscription] = useState<TranscriptionData | null>(usableTranscription(initialTranscription));
  const [transcriptionFailed, setTranscriptionFailed] = useState(initialTranscription?.status === 'failed');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isLoadingTranscription, setIsLoadingTranscription] = useState(fetchTranscriptionOnMount);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState(0);
  const [transcriptSearchQuery, setTranscriptSearchQuery] = useState('');

  // Tab state
  const [activeTab, setActiveTab] = useState<string>(tabs[0] || 'transcript');
  const [isMinimized, setIsMinimized] = useState(false);

  // Delete state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Refs for transcript
  const transcriptRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // WeldAgent — always call the hook (rules of hooks), but only use the result when enabled
  const weldAgentContext = useWeldAgentSafe();

  // Breadcrumbs — always call with a stable value
  useBreadcrumbs(breadcrumbs || []);

  // Restore from floating video
  useEffect(() => {
    if (!enableFloatingVideo) return;
    const pending = floatingVideoCtx?.pendingRestore;
    if (pending && pending.callId === call.id) {
      floatingVideoCtx.consumePendingRestore();
      pendingRestoreRef.current = { currentTime: pending.currentTime, isPlaying: pending.isPlaying };
      setIsMinimized(false);
      setCurrentTime(pending.currentTime);
      setSmoothTime(pending.currentTime);
    }
  }, [call.id, floatingVideoCtx, enableFloatingVideo]);

  // Restore from floating call panel
  useEffect(() => {
    if (!enableFloatingVideo) return;
    const pending = floatingCallCtx?.pendingRestore;
    if (pending && pending.callId === call.id) {
      floatingCallCtx.consumePendingRestore();
      pendingRestoreRef.current = { currentTime: pending.currentTime, isPlaying: pending.isPlaying };
      setIsMinimized(false);
      setCurrentTime(pending.currentTime);
      setSmoothTime(pending.currentTime);
    }
  }, [call.id, floatingCallCtx, enableFloatingVideo]);

  // Speakers derived state
  const speakers = useMemo<SpeakerInfo[]>(() => {
    if (!transcription?.segments?.length) return [];
    const speakerMap = new Map<string, SpeakerInfo>();

    transcription.segments.forEach((segment) => {
      const speakerLabel = segment.speaker || 'Unknown';
      const speakerId = parseSpeakerId(speakerLabel);

      if (!speakerMap.has(speakerLabel)) {
        speakerMap.set(speakerLabel, {
          id: speakerId,
          label: speakerLabel,
          name: segment.speakerName || null,
          segmentCount: 0,
          totalDuration: 0,
          firstSegmentStart: segment.start || 0,
          segments: [],
        });
      }

      const speaker = speakerMap.get(speakerLabel)!;
      speaker.segmentCount++;
      speaker.totalDuration += (segment.end || 0) - (segment.start || 0);
      speaker.segments.push({ start: segment.start || 0, end: segment.end || 0 });
      if (segment.speakerName && !speaker.name) {
        speaker.name = segment.speakerName;
      }
    });

    return Array.from(speakerMap.values()).sort((a, b) => a.id - b.id);
  }, [transcription?.segments]);

  const transcriptionTotalDuration = useMemo(() => {
    if (!transcription?.segments?.length) return 0;
    const lastSegment = transcription.segments[transcription.segments.length - 1];
    return lastSegment.end || 0;
  }, [transcription?.segments]);

  const flattenedTimeline = useMemo<FlatTimelineSegment[]>(() => {
    if (!transcription?.segments?.length) return [];
    const raw: FlatTimelineSegment[] = [];
    transcription.segments.forEach((seg) => {
      const speakerLabel = seg.speaker || 'Unknown';
      const speakerId = parseSpeakerId(speakerLabel);
      const hex = getSpeakerHex(speakerId);
      raw.push({ start: seg.start || 0, end: seg.end || 0, hex, speakerId });
    });
    const merged: FlatTimelineSegment[] = [];
    for (const seg of raw) {
      const prev = merged[merged.length - 1];
      if (prev && prev.speakerId === seg.speakerId && Math.abs(seg.start - prev.end) < 0.5) {
        prev.end = seg.end;
      } else {
        merged.push({ ...seg });
      }
    }
    return merged;
  }, [transcription?.segments]);

  const totalSpeakingTime = useMemo(() => {
    return speakers.reduce((sum, s) => sum + s.totalDuration, 0);
  }, [speakers]);

  const callDuration = call.duration || 0;

  // Find active segment
  const findActiveSegment = useCallback((time: number) => {
    if (!transcription?.segments?.length) return null;
    const active = transcription.segments.find((segment) =>
      time >= segment.start && time <= segment.end
    );
    if (!active) {
      const previous = [...transcription.segments]
        .reverse()
        .find((segment) => time >= segment.start);
      return previous?.id || null;
    }
    return active.id;
  }, [transcription?.segments]);

  // Seek to segment
  const seekToSegment = useCallback((startTime: number) => {
    if (mediaRef.current) {
      mediaRef.current.currentTime = startTime;
      setSmoothTime(startTime);
      setCurrentTime(startTime);
      if (!isPlaying) {
        mediaRef.current.play();
        setIsPlaying(true);
      }
    }
  }, [isPlaying, mediaRef]);

  const togglePlayPause = useCallback(() => {
    if (mediaRef.current) {
      if (isPlaying) {
        mediaRef.current.pause();
      } else {
        mediaRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  }, [isPlaying, mediaRef]);

  const handleSeek = useCallback((time: number) => {
    setCurrentTime(time);
    setSmoothTime(time);
  }, []);

  // Fetch transcription on mount
  // Resolves to the fetched row's status, so the mount effect can resume
  // polling for a transcription that is still running.
  const fetchTranscription = useCallback(async (): Promise<string | undefined> => {
    if (!transcriptionActions?.onFetchTranscription) return undefined;
    try {
      const result = await transcriptionActions.onFetchTranscription(call.id);
      const data = result.success ? result.transcription : null;
      if (data) {
        setTranscriptionFailed(data.status === 'failed');
        setTranscription(usableTranscription(data));
      }
      return data?.status;
    } catch {
      return undefined;
    } finally {
      setIsLoadingTranscription(false);
    }
  }, [call.id, transcriptionActions]);

  // Polling interval ref for cleanup
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Shared polling logic
  const startPolling = useCallback((showToasts = true) => {
    if (pollIntervalRef.current) return; // Already polling

    const estimatedSeconds = Math.max(30, (callDuration || 60) * 0.5 + 10);
    const progressIncrement = 90 / (estimatedSeconds * (1000 / 3000));
    let progress = 5;
    const startTime = Date.now();
    const TIMEOUT_MS = 10 * 60 * 1000;

    const stopPolling = () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    };

    const finishTranscribing = () => {
      setIsTranscribing(false);
      setTranscriptionProgress(0);
    };

    const handleTimeout = () => {
      stopPolling();
      if (showToasts) {
        toast.error(t('sweep.weldcrm.meetingIntelligence.transcriptionTimedOut'), {
          description: t('sweep.weldcrm.meetingIntelligence.transcriptionTimedOutDescription'),
        });
      }
      finishTranscribing();
    };

    const handleCompleted = async () => {
      stopPolling();
      setTranscriptionProgress(100);
      await fetchTranscription();
      if (showToasts) {
        toast.success(t('sweep.weldcrm.meetingIntelligence.transcriptionComplete'), {
          description: t('sweep.weldcrm.meetingIntelligence.transcriptionCompleteDescription'),
        });
      }
      setTimeout(finishTranscribing, 500);
    };

    // The stored errorMessage is the pipeline's internal error (provider HTTP
    // bodies, missing config), so it stays out of the UI.
    const handleFailed = () => {
      stopPolling();
      if (showToasts) {
        toast.error(t('sweep.weldcrm.meetingIntelligence.transcriptionFailed'), {
          description: t('sweep.weldcrm.transcriptTab.transcriptionFailedDescription'),
        });
      }
      setTranscriptionFailed(true);
      finishTranscribing();
    };

    pollIntervalRef.current = setInterval(async () => {
      try {
        progress = Math.min(90, progress + progressIncrement);
        setTranscriptionProgress(progress);

        if (Date.now() - startTime > TIMEOUT_MS) {
          handleTimeout();
          return;
        }

        if (!transcriptionActions?.onPollStatus) return;
        const statusResult = await transcriptionActions.onPollStatus(call.id);
        const status = statusResult.status?.status;

        if (status === 'completed') {
          await handleCompleted();
        } else if (status === 'failed') {
          handleFailed();
        }
      } catch {
        // Don't stop polling on transient errors
      }
    }, 3000);
  }, [call.id, callDuration, transcriptionActions, fetchTranscription, t]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  // Auto-poll if initial transcription arrived with 'processing' status
  useEffect(() => {
    if (isTranscriptionInProgress(initialTranscription?.status) && transcriptionActions?.onPollStatus) {
      setIsTranscribing(true);
      startPolling(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle transcribe
  const handleTranscribe = useCallback(async () => {
    if (!transcriptionActions?.onTranscribe) return;
    try {
      setIsTranscribing(true);
      setTranscriptionProgress(0);

      const result = await transcriptionActions.onTranscribe(call.id);

      // The user backed out of a confirmation: nothing started, nothing to report.
      if (result.cancelled) {
        setIsTranscribing(false);
        setTranscriptionProgress(0);
        return;
      }
      setTranscriptionFailed(false);

      if (!result.success) {
        if (result.error === 'insufficient_credits') {
          toast.error(t('sweep.weldcrm.meetingIntelligence.insufficientCredits'), {
            description: result.message || t('sweep.weldcrm.meetingIntelligence.insufficientCreditsDescription'),
          });
        } else {
          toast.error(t('sweep.weldcrm.meetingIntelligence.transcriptionFailed'), {
            description: result.error || t('sweep.weldcrm.meetingIntelligence.failedToStartTranscription'),
          });
        }
        setIsTranscribing(false);
        setTranscriptionProgress(0);
        return;
      }

      startPolling(true);
    } catch (error: unknown) {
      toast.error(t('sweep.weldcrm.meetingIntelligence.transcriptionFailed'), {
        description: (error as Error)?.message || t('sweep.weldcrm.meetingIntelligence.failedToStartTranscription'),
      });
      setIsTranscribing(false);
      setTranscriptionProgress(0);
    }
  }, [call.id, transcriptionActions, startPolling, t]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!onDelete) return;
    try {
      const result = await onDelete(call.id);

      if (!result.success) {
        toast.error(t('sweep.weldcrm.meetingIntelligence.failedToDeleteCall'), {
          description: result.error || t('sweep.weldcrm.meetingIntelligence.deleteCallErrorDescription'),
        });
        return;
      }

      toast.success(t('sweep.weldcrm.meetingIntelligence.callDeleted'), {
        description: t('sweep.weldcrm.meetingIntelligence.callDeletedDescription'),
      });

      router.push(deleteRedirectUrl || '/weldcrm/calls');
    } catch (error: unknown) {
      toast.error(t('sweep.weldcrm.meetingIntelligence.failedToDeleteCall'), {
        description: (error as Error)?.message || t('sweep.weldcrm.meetingIntelligence.deleteCallErrorDescription'),
      });
    } finally {
      setShowDeleteDialog(false);
    }
  }, [call.id, onDelete, deleteRedirectUrl, router, t]);

  // Fetch transcription on mount. A transcription still running after a reload resumes polling, so the user
  // sees it finish (or fail) instead of an empty Transcript tab.
  useEffect(() => {
    if (!fetchTranscriptionOnMount) return;
    let cancelled = false;
    fetchTranscription().then((status) => {
      if (cancelled || !isTranscriptionInProgress(status) || !transcriptionActions?.onPollStatus) return;
      setIsTranscribing(true);
      startPolling(true);
    });
    return () => {
      cancelled = true;
    };
  }, [call.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The host page says the transcript or summary changed (it finished after the
  // meeting, or a summary was written): load it again.
  useEffect(() => {
    if (transcriptionRefreshKey === undefined) return;
    if (!transcription) setIsLoadingTranscription(true);
    fetchTranscription();
  }, [transcriptionRefreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // WeldAgent context
  useEffect(() => {
    if (!enableWeldAgent || !weldAgentContext?.setEntityContext) return;

    if (transcription?.fullText || transcription?.segments?.length) {
      const transcriptionText = transcription.fullText ||
        transcription.segments?.map((s) => `${s.speaker}: ${s.text}`).join('\n') || '';

      const customSystemPrompt = `You are WeldAgent, an AI assistant helping analyze a call recording and its transcription.

Call Subject: ${call.subject || 'Untitled Call'}

The user will ask you questions about this call. Use the transcription provided in the context to answer their questions accurately.

Be helpful, concise, and specific. When referencing parts of the conversation, you can mention speaker names and approximate timestamps if relevant.

Here is the full transcription of the call:
---
${transcriptionText}
---`;

      weldAgentContext.setEntityContext({
        type: 'call',
        id: call.id,
        title: call.subject || t('sweep.weldcrm.meetingIntelligence.callRecording'),
        customSystemPrompt,
        data: {
          callSubject: call.subject,
          transcriptionText,
        },
        suggestedTools: ['list-contacts', 'get-contact', 'create-contact', 'create-task', 'list-tasks'],
      });
    } else {
      weldAgentContext.setEntityContext(null);
    }

    return () => {
      if (weldAgentContext?.setEntityContext) {
        weldAgentContext.setEntityContext(null);
      }
    };
    // weldAgentContext is a fresh object every render (context value isn't
    // memoized) — depending on the whole object would re-run this on every
    // render and fight with the setEntityContext call inside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.id, call.subject, transcription, enableWeldAgent, weldAgentContext?.setEntityContext, t]);

  // Update active segment based on video time
  useEffect(() => {
    const newActiveId = findActiveSegment(currentTime);
    if (newActiveId !== activeSegmentId) {
      setActiveSegmentId(newActiveId);
      if (autoScroll && newActiveId && segmentRefs.current.has(newActiveId)) {
        const element = segmentRefs.current.get(newActiveId);
        element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [currentTime, findActiveSegment, activeSegmentId, autoScroll]);

  // Media event listeners
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    const updateTime = () => {
      // Ignore the spurious huge currentTime emitted while we force a
      // duration scan (see fixInfiniteDuration below).
      if (durationFixingRef.current) return;
      setCurrentTime(media.currentTime);
    };
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    // After the duration is known, restore any saved position / play state.
    const applyPendingRestore = () => {
      const pr = pendingRestoreRef.current;
      if (!pr) return;
      pendingRestoreRef.current = null;
      media.currentTime = pr.currentTime;
      if (pr.isPlaying) {
        media.play().catch(() => {});
        setIsPlaying(true);
      }
    };

    // Composite/WebM recordings often arrive without a duration in the header,
    // so the browser reports `Infinity` (or 0) until the whole file is scanned —
    // which leaves the seekbar stuck at 0:00 and breaks scrubbing/playback.
    // Force the scan by seeking to a huge time; the browser then settles the
    // real duration (durationchange), after which we reset to the start.
    const fixInfiniteDuration = () => {
      durationFixingRef.current = true;
      const onDurationChange = () => {
        if (!Number.isFinite(media.duration) || media.duration <= 0) return;
        media.removeEventListener('durationchange', onDurationChange);
        durationFixingRef.current = false;
        setDuration(media.duration);
        // We seeked to the end to force the scan — reset to the restore point
        // (or the start) so the user begins at 0:00.
        media.currentTime = pendingRestoreRef.current?.currentTime ?? 0;
        setCurrentTime(media.currentTime);
        applyPendingRestore();
      };
      media.addEventListener('durationchange', onDurationChange);
      try {
        media.currentTime = 1e101;
      } catch {
        // Some browsers throw on an out-of-range seek — fall back gracefully.
        media.removeEventListener('durationchange', onDurationChange);
        durationFixingRef.current = false;
      }
    };

    const onMetadataLoaded = () => {
      if (Number.isFinite(media.duration) && media.duration > 0) {
        setDuration(media.duration);
        applyPendingRestore();
      } else {
        // duration is Infinity / 0 / Number.NaN → force the browser to compute it.
        fixInfiniteDuration();
      }
    };

    media.addEventListener('timeupdate', updateTime);
    media.addEventListener('loadedmetadata', onMetadataLoaded);
    media.addEventListener('play', handlePlay);
    media.addEventListener('pause', handlePause);

    if (media.readyState >= 1) {
      onMetadataLoaded();
    }

    return () => {
      media.removeEventListener('timeupdate', updateTime);
      media.removeEventListener('loadedmetadata', onMetadataLoaded);
      media.removeEventListener('play', handlePlay);
      media.removeEventListener('pause', handlePause);
    };
  }, [isMinimized, mediaRef]);

  // The expiry that belongs to the URL actually in use. A later prop value
  // belongs to a newer token the player never adopted, so it is ignored.
  useEffect(() => {
    if (expirySeededRef.current || !stableRecordingUrl.current) return;
    expirySeededRef.current = true;
    setActiveExpiresAt(recordingUrlExpiresAt ?? null);
  }, [recordingUrl, recordingUrlExpiresAt]);

  const refreshPlaybackUrl = useCallback(async () => {
    const refresh = refreshCallbackRef.current;
    if (!refresh || refreshingRef.current) return;
    // A source that fails for another reason must not loop on renewals.
    if (Date.now() - lastRefreshAtRef.current < 15_000) return;
    refreshingRef.current = true;
    lastRefreshAtRef.current = Date.now();
    try {
      const fresh = await refresh();
      if (!fresh?.url || fresh.url === stableRecordingUrl.current) return;
      const media = mediaRef.current;
      if (media) {
        // loadedmetadata of the new source restores position and play state.
        pendingRestoreRef.current = {
          currentTime: media.currentTime,
          isPlaying: !media.paused && !media.ended,
        };
      }
      stableRecordingUrl.current = fresh.url;
      setActiveExpiresAt(fresh.expiresAt ?? null);
      setSourceVersion((v) => v + 1);
    } catch {
      // Keep the current source; the next error or the user's retry renews again.
    } finally {
      refreshingRef.current = false;
    }
  }, [mediaRef]);

  // Renew about two minutes before the token expires.
  const canRefreshUrl = !!onRefreshRecordingUrl;
  useEffect(() => {
    if (!canRefreshUrl || !activeExpiresAt) return;
    const expiresAtMs = Date.parse(activeExpiresAt);
    if (Number.isNaN(expiresAtMs)) return;
    const delay = Math.max(expiresAtMs - Date.now() - 2 * 60_000, 0);
    const timer = setTimeout(() => void refreshPlaybackUrl(), delay);
    return () => clearTimeout(timer);
  }, [canRefreshUrl, activeExpiresAt, refreshPlaybackUrl]);

  // An expired token answers 404: the element errors, and we renew.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !canRefreshUrl) return;
    const onError = () => void refreshPlaybackUrl();
    media.addEventListener('error', onError);
    return () => media.removeEventListener('error', onError);
  }, [isMinimized, mediaRef, canRefreshUrl, refreshPlaybackUrl]);

  // Smooth 60fps time tracking
  useEffect(() => {
    const tick = () => {
      if (mediaRef.current) {
        setSmoothTime(mediaRef.current.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    if (isPlaying) {
      rafRef.current = requestAnimationFrame(tick);
    } else if (mediaRef.current) {
      setSmoothTime(mediaRef.current.currentTime);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, mediaRef]);

  // Handle minimize to floating
  const handleMinimize = useCallback(() => {
    if (!enableFloatingVideo || !stableRecordingUrl.current) return;

    if (floatingCallCtx) {
      floatingCallCtx.minimize({
        callId: call.id,
        callSubject: call.subject || t('sweep.weldcrm.meetingIntelligence.callRecording'),
        callDate: call.date,
        callDuration: callDuration,
        videoSrc: stableRecordingUrl.current,
        currentTime: videoRef.current?.currentTime || currentTime,
        isPlaying,
        segments: (transcription?.segments || []).map((s) => ({
          id: s.id,
          speaker: s.speaker || '',
          speakerName: s.speakerName,
          text: s.text,
          start: s.start,
          end: s.end,
        })),
        attendees: call.attendees,
        platform: call.platform || '',
        meetingUrl: call.meetingUrl || '',
      });
    } else if (floatingVideoCtx) {
      floatingVideoCtx.minimize({
        src: stableRecordingUrl.current,
        currentTime: videoRef.current?.currentTime || currentTime,
        isPlaying,
        callSubject: call.subject || t('sweep.weldcrm.meetingIntelligence.callRecording'),
        callId: call.id,
      });
    }

    if (videoRef.current) videoRef.current.pause();
    setIsMinimized(true);
    router.back();
  }, [enableFloatingVideo, call, callDuration, currentTime, isPlaying, transcription?.segments, floatingCallCtx, floatingVideoCtx, router, t]);

  // Floating video minimize from video player controls
  const handleVideoMinimize = useCallback(() => {
    if (!enableFloatingVideo || !stableRecordingUrl.current || !floatingVideoCtx) return;
    floatingVideoCtx.minimize({
      src: stableRecordingUrl.current,
      currentTime: videoRef.current?.currentTime || currentTime,
      isPlaying,
      callSubject: call.subject || t('sweep.weldcrm.meetingIntelligence.callRecording'),
      callId: call.id,
    });
    if (videoRef.current) videoRef.current.pause();
    setIsMinimized(true);
  }, [enableFloatingVideo, call, currentTime, isPlaying, floatingVideoCtx, t]);

  // Word-level highlight tracking — use smoothTime (60fps) for responsive word highlighting
  const activeWordIndex = useActiveWord(transcription?.segments, activeSegmentId, smoothTime);

  const hasTranscription = !!transcription;
  // Progress state while we poll after a Transcribe click, or while the host page
  // knows one is being produced (e.g. a transcript that arrives after the meeting).
  const showTranscribing = isTranscribing || (transcriptionPending && !hasTranscription);

  const headerMinimizeHandler = enableFloatingVideo && stableRecordingUrl.current && floatingCallCtx ? handleMinimize : undefined;
  const playerMinimizeHandler = enableFloatingVideo && floatingVideoCtx && stableRecordingUrl.current ? handleVideoMinimize : undefined;
  const transcribeHandler = transcriptionActions?.onTranscribe ? handleTranscribe : undefined;

  // Full-width layout (for call detail pages)
  return (
    <div className="h-full flex bg-gray-50 dark:bg-background overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0">
        {/* Top Header */}
        <MeetingIntelligenceHeader
          call={call}
          mediaType={mediaType}
          videoDuration={duration}
          isTranscribing={showTranscribing}
          hasTranscription={hasTranscription}
          isLoadingTranscription={isLoadingTranscription}
          onBack={() => backUrl ? router.push(backUrl) : router.push('/weldcrm/calls')}
          onDelete={onDelete ? () => setShowDeleteDialog(true) : undefined}
          onMinimize={headerMinimizeHandler}
          onCopyJoinCode={headerMenuActions?.onCopyJoinCode}
          onCopyLink={headerMenuActions?.onCopyLink}
          onRename={headerMenuActions?.onRename}
          onScheduleAgain={headerMenuActions?.onScheduleAgain}
          onDownloadRecording={headerMenuActions?.onDownloadRecording}
          onDeleteRecording={headerMenuActions?.onDeleteRecording}
          deleteRecordingLabel={headerMenuActions?.deleteRecordingLabel}
          onExportTranscript={headerMenuActions?.onExportTranscript}
          headerActions={headerActions}
        />

        {/* Delete Confirmation Dialog */}
        <ConfirmDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          title={t('sweep.weldcrm.meetingIntelligence.deleteMeetingTitle')}
          description={t('sweep.weldcrm.meetingIntelligence.deleteMeetingDescription')}
          confirmLabel={t('sweep.weldcrm.meetingIntelligence.deleteMeetingConfirm')}
          variant="destructive"
          onConfirm={handleDelete}
        />

        {/* Content Area */}
        <div className="flex-1 flex overflow-hidden">
          <div className={cn("flex-1 bg-white dark:bg-background overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]", renderSidebar && "min-w-0")}>
            {/* Media Player */}
            {!isMinimized && isAudio && (
              <AudioPlayer
                src={stableRecordingUrl.current}
                audioRef={audioRef}
                isPlaying={isPlaying}
                currentTime={currentTime}
                smoothTime={smoothTime}
                duration={duration}
                flattenedTimeline={flattenedTimeline}
                segments={transcription?.segments}
                onTogglePlayPause={togglePlayPause}
                onSeek={handleSeek}
              />
            )}
            {!isMinimized && !isAudio && mediaType !== 'none' && (
              <VideoPlayer
                src={stableRecordingUrl.current}
                videoRef={videoRef}
                isPlaying={isPlaying}
                currentTime={currentTime}
                smoothTime={smoothTime}
                duration={duration}
                flattenedTimeline={flattenedTimeline}
                segments={transcription?.segments}
                onTogglePlayPause={togglePlayPause}
                onSeek={handleSeek}
                onMinimize={playerMinimizeHandler}
              />
            )}

            {!isMinimized && mediaType === 'none' && mediaSlot}

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="pb-4">
              <div className="sticky top-0 z-10 bg-white dark:bg-background px-4 pt-[10px] overflow-hidden">
                <div className="flex items-center gap-2 mb-[10px]">
                  <div className="flex items-center gap-1">
                    {tabs.map((tab, tabIndex) => {
                      const isFirst = tabIndex === 0;
                      const tabConfig = {
                        transcript: { icon: Captions, label: tabLabels?.transcript ?? t('sweep.weldcrm.meetingIntelligence.tabTranscript') },
                        summary: { icon: Sparkles, label: tabLabels?.summary ?? 'Summary' },
                        speakers: { icon: Users, label: tabLabels?.speakers ?? t('sweep.weldcrm.meetingIntelligence.tabSpeakers') },
                        meeting: { icon: Video, label: tabLabels?.meeting ?? (isAudio ? t('sweep.weldcrm.meetingIntelligence.tabDetails') : t('sweep.weldcrm.meetingIntelligence.tabMeeting')) },
                      }[tab];
                      if (!tabConfig) return null;
                      const TabIcon = tabConfig.icon;
                      return (
                        <div key={tab} className="relative group">
                          <Button
                            variant="ghost"
                            size="sm"
                            className={cn(
                              "text-xs md:text-sm hover:bg-transparent",
                              isFirst ? "!pl-0 pr-2 md:pr-3" : "px-2 md:px-3",
                              activeTab === tab ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                            )}
                            onClick={() => setActiveTab(tab)}
                          >
                            <TabIcon className="h-3 w-3 mr-0.5" />
                            {tabConfig.label}
                          </Button>
                          <div className={cn(
                            "absolute -bottom-[11px] right-[6px] md:right-[10px] h-0.5 transition-colors",
                            isFirst ? "left-0" : "left-[6px] md:left-[10px]",
                            activeTab === tab ? "bg-foreground" : "bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600"
                          )} />
                        </div>
                      );
                    })}
                  </div>



                  {/* Tab-specific toolbars */}
                  {activeTab === 'transcript' && transcription?.segments && transcription.segments.length > 0 && (
                    <div className="ml-auto flex items-center gap-1.5">
                      <TranscriptSearchToolbar
                        searchQuery={transcriptSearchQuery}
                        onSearchQueryChange={setTranscriptSearchQuery}
                      />
                      <AutoScrollSelect autoScroll={autoScroll} onAutoScrollChange={setAutoScroll} />
                    </div>
                  )}
                  {activeTab === 'speakers' && speakers.length > 0 && (
                    <SpeakerSearchToolbar />
                  )}
                </div>
                <div className="border-b border-gray-200 dark:border-border -mx-4" />
              </div>

              {tabs.includes('transcript') && (
                <TabsContent value="transcript" className="mt-0">
                  <div ref={transcriptRef}>
                    <TranscriptTabContent
                      segments={transcription?.segments}
                      isLoading={isLoadingTranscription}
                      isTranscribing={showTranscribing}
                      transcriptionFailed={transcriptionFailed}
                      transcriptionProgress={transcriptionProgress}
                      hasTranscription={hasTranscription}
                      activeSegmentId={activeSegmentId}
                      activeWordIndex={activeWordIndex}
                      searchQuery={transcriptSearchQuery}
                      onSeekToSegment={seekToSegment}
                      onSeekToTime={seekToSegment}
                      onTranscribe={transcribeHandler}
                      emptyHint={transcriptEmptyHint}
                      segmentRefs={segmentRefs}
                    />
                  </div>
                </TabsContent>
              )}

              {tabs.includes('summary') && (
                <TabsContent value="summary" className="mt-0 px-4">
                  {renderSummary?.()}
                </TabsContent>
              )}

              {tabs.includes('speakers') && (
                <TabsContent value="speakers" className="mt-0 px-4 overflow-x-hidden">
                  <SpeakersTabContent
                    speakers={speakers}
                    totalSpeakingTime={totalSpeakingTime}
                    transcriptionTotalDuration={transcriptionTotalDuration}
                    smoothTime={smoothTime}
                    hasTranscription={hasTranscription}
                    isTranscribing={showTranscribing}
                    onSeekToSegment={seekToSegment}
                    onTranscribe={transcribeHandler}
                  />
                </TabsContent>
              )}

              {tabs.includes('meeting') && (
                <TabsContent value="meeting" className="mt-0 px-4">
                  <MeetingDetailsTab call={call} mediaType={mediaType} videoDuration={duration} />
                </TabsContent>
              )}
            </Tabs>
          </div>
        </div>
      </div>
      {renderSidebar && (
        <div className="w-[479px] flex-shrink-0 border-l flex flex-col bg-white dark:bg-background animate-in slide-in-from-right fade-in-50 duration-200">
          {renderSidebar({ transcription })}
        </div>
      )}
    </div>
  );
}

// Inline small toolbar components to keep them co-located with the orchestrator

import { Search } from 'lucide-react';

function AutoScrollSelect({
  autoScroll,
  onAutoScrollChange,
}: {
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
}) {
  const t = useTranslations();

  return (
    <Select value={autoScroll ? 'on' : 'off'} onValueChange={(v) => onAutoScrollChange(v === 'on')}>
      <SelectTrigger size="sm" className="h-8 text-[14px] w-auto gap-1.5 px-2.5 leading-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="on">{t('sweep.weldcrm.meetingIntelligence.autoScroll')}</SelectItem>
        <SelectItem value="off">{t('sweep.weldcrm.meetingIntelligence.manualScroll')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function TranscriptSearchToolbar({
  searchQuery,
  onSearchQueryChange,
}: {
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
}) {
  const t = useTranslations();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <div className="relative flex items-center">
      <div className={cn(
        "flex items-center transition-all duration-200 ease-out",
        searchOpen ? "w-48" : "w-8"
      )}>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200",
            searchOpen && "opacity-0 pointer-events-none absolute"
          )}
          onClick={() => {
            setSearchOpen(true);
            setTimeout(() => searchRef.current?.focus(), 50);
          }}
        >
          <Search className="h-4 w-4" />
        </Button>
        <div className={cn(
          "relative transition-all duration-200 ease-out",
          searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
        )}>
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            ref={searchRef}
            type="text"
            placeholder={t('sweep.weldcrm.meetingIntelligence.searchTranscript')}
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            onBlur={() => !searchQuery && setSearchOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onSearchQueryChange('');
                setSearchOpen(false);
              }
            }}
            className="h-8 w-full pl-8 pr-3 text-sm border border-gray-200 dark:border-border rounded-md bg-white dark:bg-background focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
}

function SpeakerSearchToolbar() {
  const t = useTranslations();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <div className="ml-auto flex items-center">
      <div className="relative flex items-center">
        <div className={cn(
          "flex items-center transition-all duration-200 ease-out",
          searchOpen ? "w-48" : "w-8"
        )}>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200",
              searchOpen && "opacity-0 pointer-events-none absolute"
            )}
            onClick={() => {
              setSearchOpen(true);
              setTimeout(() => searchRef.current?.focus(), 50);
            }}
          >
            <Search className="h-4 w-4" />
          </Button>
          <div className={cn(
            "relative transition-all duration-200 ease-out",
            searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
          )}>
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              ref={searchRef}
              type="text"
              placeholder={t('sweep.weldcrm.meetingIntelligence.searchSpeakers')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onBlur={() => !searchQuery && setSearchOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchQuery('');
                  setSearchOpen(false);
                }
              }}
              className="h-8 w-full pl-8 pr-3 text-sm border border-gray-200 dark:border-border rounded-md bg-white dark:bg-background focus:outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
