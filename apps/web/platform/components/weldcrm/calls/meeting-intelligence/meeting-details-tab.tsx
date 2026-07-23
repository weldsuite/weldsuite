
import { format } from 'date-fns';
import { Link } from '@tanstack/react-router';
import { Clock, LogIn, LogOut, Phone, Timer, Video, UserCircle2, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { detectPlatform, formatDuration } from './utils';
import type { MeetingIntelligenceCall, MeetingAttendeeDetail } from './types';
import { useTranslations } from '@weldsuite/i18n/client';

interface MeetingDetailsTabProps {
  call: MeetingIntelligenceCall;
  mediaType?: 'video' | 'audio' | 'none';
  videoDuration?: number;
}

function formatSessionDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}h ${mins}m ${secs}s`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

function formatParticipantDuration(joinedAt: string, leftAt?: string): string {
  const start = new Date(joinedAt).getTime();
  const end = leftAt ? new Date(leftAt).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  return formatSessionDuration(seconds);
}

export function MeetingDetailsTab({ call, mediaType = 'video', videoDuration }: MeetingDetailsTabProps) {
  const t = useTranslations();
  const callDate = new Date(call.date);
  const callDuration = call.duration || 0;
  const platformInfo = detectPlatform(call.platform, call.meetingUrl);

  const hasSessionData = !!call.sessionParticipants?.length;
  // Prefer rich attendee data (with profile links) over plain name strings.
  const fallbackParticipants: MeetingAttendeeDetail[] = call.attendeeDetails?.length
    ? call.attendeeDetails
    : (call.attendees?.map((name) => ({ name })) ?? []);

  return (
    <div className="py-3 space-y-4">
      {/* Date & Time Card */}
      <div>
        <div className="flex items-center gap-2.5">
          <div className="h-[34px] w-11 rounded-lg bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border flex items-center justify-center flex-shrink-0">
            {platformInfo ? (
              <img src={platformInfo.icon} alt={platformInfo.name} className="h-5 w-5" />
            ) : mediaType === 'audio' ? (
              <Phone className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
            ) : (
              <Video className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
            )}
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-900 dark:text-foreground">{format(callDate, 'EEEE, MMMM d, yyyy')}</p>
            <p className="text-xs text-gray-500 dark:text-muted-foreground">{format(callDate, 'h:mm a')}</p>
          </div>
          <div className="flex items-center gap-2">
            {callDuration > 0 ? (
              <span className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground">
                {formatDuration(callDuration)}
              </span>
            ) : null}
            {(videoDuration && videoDuration > 0 && callDuration === 0) ? (
              <span className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground">
                {formatDuration(Math.floor(videoDuration))}
              </span>
            ) : null}
            {platformInfo ? (
              <span className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground">
                {platformInfo.name}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Meeting Duration */}
      {(call.sessionDuration != null && call.sessionDuration > 0) && (
        <>
          <div className="h-px bg-border" />
          <div>
            <h3 className="text-xs font-medium text-gray-500 dark:text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Timer className="h-3 w-3" />
              {t('sweep.weldcrm.meetingDetailsTab.meetingDuration')}
            </h3>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">
                  {t('sweep.weldcrm.meetingDetailsTab.totalTime')}
                </span>
                <span className="text-sm font-mono font-medium text-gray-900 dark:text-foreground">
                  {formatSessionDuration(call.sessionDuration)}
                </span>
              </div>
              {call.sessionStartedAt && call.sessionEndedAt && (
                <div className="flex items-center justify-between mt-2 text-xs text-gray-500 dark:text-muted-foreground">
                  <span>{format(new Date(call.sessionStartedAt), 'h:mm:ss a')}</span>
                  <span className="text-gray-300 dark:text-border">—</span>
                  <span>{format(new Date(call.sessionEndedAt), 'h:mm:ss a')}</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Description */}
      {call.description && (
        <div className="rounded-lg border border-gray-200 dark:border-border p-3.5">
          <h3 className="text-xs font-medium text-gray-500 dark:text-muted-foreground mb-2">{t('sweep.weldcrm.meetingDetailsTab.description')}</h3>
          <p className="text-sm text-gray-700 dark:text-muted-foreground leading-relaxed">{call.description}</p>
        </div>
      )}

      {/* Session Participants (with join/leave timestamps) */}
      {hasSessionData && (
        <>
        <div className="h-px bg-border" />
        <div>
          <h3 className="text-xs font-medium text-gray-500 dark:text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
            {t('sweep.weldcrm.meetingDetailsTab.participants')}
            <span className="text-[10px] font-mono w-[18px] h-[18px] flex items-center justify-center rounded-[5px] bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground normal-case tracking-normal">
              <span className="translate-y-[0.5px]">{call.sessionParticipants!.length}</span>
            </span>
          </h3>
          <div className="space-y-2">
            {call.sessionParticipants!.map((participant, i) => {
              const colors = [
                'bg-blue-500',
                'bg-emerald-500',
                'bg-violet-500',
                'bg-amber-500',
                'bg-rose-500',
                'bg-cyan-500'
              ];
              const participantColor = colors[i % colors.length];

              return (
                <div key={`${participant.userId}-${i}`} className="py-1">
                  <div className="flex items-center gap-2">
                    {participant.userAvatar ? (
                      <img
                        src={participant.userAvatar}
                        alt={participant.userName}
                        className="w-[22px] h-[22px] rounded-md flex-shrink-0 object-cover"
                      />
                    ) : (
                      <div className={cn("w-[22px] h-[22px] rounded-md flex items-center justify-center text-[10px] leading-none font-semibold text-white flex-shrink-0", participantColor)}>
                        <span>{participant.userName.charAt(0).toUpperCase()}</span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-foreground truncate">{participant.userName}</p>
                    </div>
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground flex-shrink-0">
                      {formatParticipantDuration(participant.joinedAt, participant.leftAt)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-xs text-gray-500 dark:text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <LogIn className="h-3 w-3 text-emerald-500" />
                      {t('sweep.weldcrm.meetingDetailsTab.joinedAt', { time: format(new Date(participant.joinedAt), 'h:mm:ss a') })}
                    </span>
                    {participant.leftAt && (
                      <span className="flex items-center gap-1">
                        <LogOut className="h-3 w-3 text-red-400" />
                        {t('sweep.weldcrm.meetingDetailsTab.leftAt', { time: format(new Date(participant.leftAt), 'h:mm:ss a') })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        </>
      )}

      {/* Invited Participants (fallback when no session data) */}
      {!hasSessionData && fallbackParticipants.length > 0 && (
        <>
        <div className="h-px bg-border" />
        <div>
          <h3 className="text-xs font-medium text-gray-500 dark:text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
            {t('sweep.weldcrm.meetingDetailsTab.participants')}
            <span className="text-[10px] font-mono w-[18px] h-[18px] flex items-center justify-center rounded-[5px] bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground normal-case tracking-normal"><span className="translate-y-[0.5px]">{fallbackParticipants.length}</span></span>
          </h3>
          <div className="space-y-2.5">
            {fallbackParticipants.map((participant, i) => (
              <ParticipantRow key={`${participant.email ?? ''}-${participant.workspaceMemberId ?? ''}-${i}`} participant={participant} index={i} />
            ))}
          </div>
        </div>
        </>
      )}

      {/* Meeting Link */}
      {call.meetingUrl && (
        <div className="rounded-lg border border-gray-200 dark:border-border p-3.5">
          <h3 className="text-xs font-medium text-gray-500 dark:text-muted-foreground uppercase tracking-wider mb-2">{t('sweep.weldcrm.meetingDetailsTab.meetingLink')}</h3>
          <a
            href={call.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline truncate block"
          >
            {call.meetingUrl}
          </a>
        </div>
      )}

      {/* Tags */}
      {call.tags && call.tags.length > 0 && (
        <div className="rounded-lg border border-gray-200 dark:border-border p-3.5">
          <h3 className="text-xs font-medium text-gray-500 dark:text-muted-foreground uppercase tracking-wider mb-2.5">{t('sweep.weldcrm.meetingDetailsTab.tags')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {call.tags.map((tag, i) => (
              <span key={i} className="text-xs px-2 py-1 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-600 dark:text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const PARTICIPANT_COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-cyan-500',
];

/**
 * A single fallback participant row. Linked to a team member profile (when
 * matched to a workspace member) or a CRM contact; otherwise a plain row.
 */
function ParticipantRow({ participant, index }: { participant: MeetingAttendeeDetail; index: number }) {
  const t = useTranslations();
  const label = participant.name || participant.email || t('sweep.weldcrm.meetingDetailsTab.unknown');
  const initials = (participant.name?.[0] ?? participant.email?.[0] ?? '?').toUpperCase();
  const color = PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length];

  const inner = (
    <>
      {participant.avatar ? (
        <img
          src={participant.avatar}
          alt={label}
          className="w-[22px] h-[22px] rounded-md flex-shrink-0 object-cover"
        />
      ) : (
        <div className={cn('w-[22px] h-[22px] rounded-md flex items-center justify-center text-[10px] leading-none font-semibold text-white flex-shrink-0', color)}>
          <span>{initials}</span>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-gray-900 dark:text-foreground truncate">{label}</p>
          {participant.role === 'organizer' && (
            <span className="px-1.5 py-[2px] rounded-[5px] text-[10px] font-medium bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 flex-shrink-0">
              {t('sweep.weldcrm.meetingDetailsTab.organizer')}
            </span>
          )}
        </div>
        {participant.email && participant.email !== participant.name && (
          <p className="text-xs text-gray-500 dark:text-muted-foreground truncate">{participant.email}</p>
        )}
      </div>
      {participant.workspaceMemberId ? (
        <span className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-muted-foreground border border-gray-200 dark:border-border rounded-md px-1.5 py-0.5 shrink-0">
          <UserCircle2 className="h-3 w-3" />
          {t('sweep.weldcrm.meetingDetailsTab.teamMember')}
        </span>
      ) : participant.contactId ? (
        <span className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-muted-foreground border border-gray-200 dark:border-border rounded-md px-1.5 py-0.5 shrink-0">
          <ExternalLink className="h-3 w-3" />
          {t('sweep.weldcrm.meetingDetailsTab.contact')}
        </span>
      ) : null}
    </>
  );

  if (participant.workspaceMemberId) {
    return (
      <Link
        to="/settings/team/$memberId"
        params={{ memberId: participant.workspaceMemberId }}
        className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-md hover:bg-muted/50 transition-colors"
      >
        {inner}
      </Link>
    );
  }

  if (participant.contactId) {
    return (
      <Link
        to="/weldcrm/people"
        className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-md hover:bg-muted/50 transition-colors"
      >
        {inner}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2 py-1">
      {inner}
    </div>
  );
}
